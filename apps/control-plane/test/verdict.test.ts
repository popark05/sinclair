// computeCycle: Cycle 의 run 투영들에서 TestCase × 타깃 매트릭스와 Verdict 를 계산한다. 규칙은 specs/0001 "Verdict 규칙".
import { describe, it, expect } from 'vitest';
import { computeCycle, tagsOf, type RunView, type CycleRecord, type AttemptView } from '../src/index.ts';

const cycle: CycleRecord = { cycleId: 'c1', build: '1.2.3-45', targets: ['android', 'ios'], requiredTags: [], createdAt: '2026-11-07T00:00:00.000Z' };
const single: CycleRecord = { ...cycle, targets: ['android'] };
const attempt = (testId: string, attemptNo: number, result: AttemptView['result'], s = attemptNo): AttemptView => ({
  attemptId: `${testId}#${attemptNo}`, testId, attemptNo, startedAt: `2026-11-07T00:00:${String(s).padStart(2, '0')}.000Z`, ...(result ? { result } : {}), artifacts: [], steps: [],
});
const run = (runId: string, targetId: string, state: RunView['state'], attempts: AttemptView[]): RunView => ({ runId, state, targetId, cycleId: 'c1', attempts });
const reg = (runId: string, targetId: string) => ({ runId, cycleId: 'c1', targetId, createdAt: '2026-11-07T00:00:00.000Z' });

describe('tagsOf', () => {
  it('테스트 이름의 @토큰이 태그다', () => {
    expect(tagsOf('로그인 > 비밀번호 오류 @smoke @auth')).toEqual(['smoke', 'auth']);
    expect(tagsOf('설정 앱 > 열면 "설정" 제목이 보인다')).toEqual([]);
  });
});

describe('computeCycle', () => {
  it.each([
    ['마지막 attempt 가 통과면 passed', [attempt('A', 1, 'passed')], 'passed', 'A#1'],
    ['재시도 끝에 통과하면 passed-flaky', [attempt('A', 1, 'failed'), attempt('A', 2, 'passed')], 'passed-flaky', 'A#2'],
    ['마지막이 실패면 failed (앞에서 통과했어도)', [attempt('A', 1, 'passed'), attempt('A', 2, 'failed')], 'failed', 'A#2'],
    ['마지막이 blocked 면 blocked', [attempt('A', 1, 'failed'), attempt('A', 2, 'blocked')], 'blocked', 'A#2'],
    ['skipped 는 skipped', [attempt('A', 1, 'skipped')], 'skipped', 'A#1'],
    ['attemptNo 가 큰 것이 마지막이다 (시각 순서와 무관)', [attempt('A', 2, 'passed', 1), attempt('A', 1, 'failed', 5)], 'passed-flaky', 'A#2'],
    ['아직 끝나지 않은 attempt 는 무시하고 그 전 결과를 쓴다', [attempt('A', 1, 'failed'), attempt('A', 2, undefined)], 'failed', 'A#1'],
  ] as const)('%s', (_, attempts, verdict, attemptId) => {
    const view = computeCycle(single, [reg('r1', 'android')], [run('r1', 'android', 'finished', [...attempts])]);
    expect(view.matrix).toEqual({ A: { android: { verdict, attemptId } } });
  });

  it('run 이 없으면 draft·incomplete, 끝나지 않은 run 이 있으면 running·incomplete', () => {
    expect(computeCycle(cycle, [], [])).toMatchObject({ state: 'draft', verdict: 'incomplete', matrix: {} });
    const v = computeCycle(cycle, [reg('r1', 'android'), reg('r2', 'ios')], [run('r1', 'android', 'finished', [attempt('A', 1, 'passed')]), run('r2', 'ios', 'running', [])]);
    expect(v).toMatchObject({ state: 'running', verdict: 'incomplete' });
    expect(v.matrix).toEqual({ A: { android: { verdict: 'passed', attemptId: 'A#1' } } }); // 진행 중인 run 의 빈 칸은 아직 비어 있다
  });

  it('등록만 되고 이벤트가 없는 run 은 queued 로 보고 Cycle 은 running', () => {
    const v = computeCycle(cycle, [reg('r1', 'android'), reg('r2', 'ios')], [run('r1', 'android', 'finished', [attempt('A', 1, 'passed')])]);
    expect(v.state).toBe('running');
    expect(v.runs).toEqual([{ runId: 'r1', targetId: 'android', state: 'finished' }, { runId: 'r2', targetId: 'ios', state: 'queued' }]);
  });

  it('전부 끝나고 필수 케이스가 모두 통과(flaky 포함)면 finished·verified', () => {
    const v = computeCycle(cycle, [reg('r1', 'android'), reg('r2', 'ios')], [
      run('r1', 'android', 'finished', [attempt('A', 1, 'passed'), attempt('B', 1, 'failed'), attempt('B', 2, 'passed')]),
      run('r2', 'ios', 'finished', [attempt('A', 1, 'passed'), attempt('B', 1, 'passed')]),
    ]);
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(v.matrix.B).toEqual({ android: { verdict: 'passed-flaky', attemptId: 'B#2' }, ios: { verdict: 'passed', attemptId: 'B#1' } });
  });

  it('필수 케이스가 하나라도 failed/blocked 면 blocked', () => {
    const v = computeCycle(single, [reg('r1', 'android')], [run('r1', 'android', 'finished', [attempt('A', 1, 'passed'), attempt('B', 1, 'failed')])]);
    expect(v.verdict).toBe('blocked');
  });

  it('requiredTags 가 있으면 그 태그를 가진 케이스만 verified 판정에 들어간다', () => {
    const tagged = { ...single, requiredTags: ['smoke'] };
    const v = computeCycle(tagged, [reg('r1', 'android')], [run('r1', 'android', 'finished', [attempt('로그인 @smoke', 1, 'passed'), attempt('검색', 1, 'failed')])]);
    expect(v.verdict).toBe('verified');
    expect(v.required).toEqual(['로그인 @smoke']);
    expect(v.matrix['검색']!.android!.verdict).toBe('failed'); // 매트릭스에는 그대로 보인다
  });

  it('infra-failed 로 끝난 run 에서 돌지 못한 케이스는 blocked, finished run 에 없는 케이스는 skipped', () => {
    const v = computeCycle(cycle, [reg('r1', 'android'), reg('r2', 'ios')], [
      run('r1', 'android', 'finished', [attempt('A', 1, 'passed'), attempt('B', 1, 'passed')]),
      run('r2', 'ios', 'infra-failed', [attempt('A', 1, 'blocked')]),
    ]);
    expect(v.matrix.B).toEqual({ android: { verdict: 'passed', attemptId: 'B#1' }, ios: { verdict: 'blocked' } });
    expect(v.verdict).toBe('blocked');
    const w = computeCycle(cycle, [reg('r1', 'android'), reg('r2', 'ios')], [
      run('r1', 'android', 'finished', [attempt('A', 1, 'passed'), attempt('B', 1, 'passed')]),
      run('r2', 'ios', 'finished', [attempt('A', 1, 'passed')]),
    ]);
    expect(w.matrix.B!.ios).toEqual({ verdict: 'skipped' });
    expect(w.verdict).toBe('blocked'); // 필수 케이스가 skipped 면 검증된 것이 아니다
  });

  it('타깃이 둘인데 run 이 하나뿐이면 다른 타깃 열이 비어 있어 verified 가 아니다', () => {
    const v = computeCycle(cycle, [reg('r1', 'android')], [run('r1', 'android', 'finished', [attempt('A', 1, 'passed')])]);
    expect(v).toMatchObject({ state: 'finished', verdict: 'blocked' });
    expect(v.matrix.A).toEqual({ android: { verdict: 'passed', attemptId: 'A#1' } });
  });

  it('등록에 없는 cycleId 의 run 은 무시하고, 타깃 순서는 Cycle 의 targets 순이다', () => {
    const v = computeCycle(cycle, [reg('r1', 'android'), reg('r2', 'ios')], [
      run('r2', 'ios', 'finished', [attempt('A', 1, 'passed')]),
      run('r1', 'android', 'finished', [attempt('A', 1, 'passed')]),
      run('rx', 'android', 'finished', [attempt('Z', 1, 'failed')]),
    ]);
    expect(Object.keys(v.matrix)).toEqual(['A']);
    expect(Object.keys(v.matrix.A!)).toEqual(['android', 'ios']);
    expect(v.verdict).toBe('verified');
  });

  it('같은 타깃에 run 이 여럿이면 뒤에 등록된 run 의 결과가 앞을 덮는다(재실행)', () => {
    const v = computeCycle(single, [reg('r1', 'android'), reg('r2', 'android')], [
      run('r1', 'android', 'finished', [attempt('A', 1, 'failed')]),
      run('r2', 'android', 'finished', [attempt('A', 1, 'passed')]),
    ]);
    expect(v.matrix.A).toEqual({ android: { verdict: 'passed', attemptId: 'A#1' } });
    expect(v.verdict).toBe('verified');
  });
});
