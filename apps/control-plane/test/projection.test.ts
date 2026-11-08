// projectRun: 저장된 RunEvent 목록에서 Run/Attempt 투영을 만든다. 도착 순서와 무관해야 한다.
import { describe, it, expect } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { projectRun } from '../src/index.ts';
import { RUN, at, base } from './fixtures.ts';


function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('projectRun', () => {
  it('완료된 run 을 Run 상태·Attempt 목록·스텝으로 투영한다', () => {
    expect(projectRun(RUN)).toEqual({
      runId: 'r1', state: 'finished', cycleId: 'c1', targetId: 'android', deviceId: 'd1', startedAt: at(0), finishedAt: at(8),
      attempts: [
        { attemptId: 'a1', testId: '로그인', attemptNo: 1, startedAt: at(1), finishedAt: at(4), result: 'passed', artifacts: [], steps: [
          { stepIndex: 0, kind: 'locator', instruction: 'tap 로그인', modelCalls: 0, durationMs: 10 },
          { stepIndex: 1, kind: 'assert', instruction: 'expect 환영', modelCalls: 0, durationMs: 5 },
        ] },
        { attemptId: 'a2', testId: '검색', attemptNo: 1, startedAt: at(5), finishedAt: at(7), result: 'failed', errorCode: 'not-found', artifacts: [{ kind: 'screenshot', key: 'a2.png' }], steps: [
          { stepIndex: 0, kind: 'locator', instruction: 'tap 없음 → 실패', modelCalls: 0, durationMs: 200 },
        ] },
      ],
    });
  });

  it('어떤 순서로 도착해도 투영이 같다 (첫 attempt 의 이벤트 5개 전수 순열 + 전체 역순)', () => {
    const expected = projectRun(RUN);
    const head = RUN.slice(0, 5);
    const tail = RUN.slice(5);
    for (const p of permutations(head)) expect(projectRun([...tail, ...p])).toEqual(expected);
    expect(projectRun([...RUN].reverse())).toEqual(expected);
  });

  it('run.finished 가 아직 없으면 running, attempt.finished 가 없으면 result 없음', () => {
    const view = projectRun(RUN.slice(0, 3));
    expect(view.state).toBe('running');
    expect(view.finishedAt).toBeUndefined();
    expect(view.attempts[0]).toMatchObject({ attemptId: 'a1', testId: '로그인', steps: [{ stepIndex: 0 }] });
    expect(view.attempts[0]!.result).toBeUndefined();
  });

  it('run.finished 가 둘이면 도착 순서와 무관하게 at 이 이른 것이 상태다(버려진 Run 의 합성 종료 뒤 늦게 온 cancelled)', () => {
    const synthetic: RunEvent = { ...base('abandoned:r1', 5), type: 'run.finished', state: 'infra-failed' };
    const late: RunEvent = { ...base('late', 9), type: 'run.finished', state: 'cancelled' };
    expect(projectRun([...RUN.slice(0, 2), synthetic, late]).state).toBe('infra-failed');
    expect(projectRun([late, ...RUN.slice(0, 2), synthetic]).state).toBe('infra-failed');
  });

  it('run.started 가 아직 없으면 state 는 queued 이고 targetId 는 비어 있다', () => {
    const view = projectRun(RUN.slice(1, 5));
    expect(view).toMatchObject({ runId: 'r1', state: 'queued', attempts: [{ attemptId: 'a1', result: 'passed' }] });
    expect(view.targetId).toBeUndefined();
  });

  it('attempt.started 없이 스텝·종료만 온 attempt 도 attemptId 로 모은다 (testId 는 비어 있음)', () => {
    const view = projectRun([RUN[0]!, RUN[6]!, RUN[7]!]);
    expect(view.attempts).toEqual([{ attemptId: 'a2', finishedAt: at(7), result: 'failed', errorCode: 'not-found', artifacts: [{ kind: 'screenshot', key: 'a2.png' }], steps: [expect.objectContaining({ stepIndex: 0 })] }]);
  });

  it('infra-failed 로 끝난 run 은 그 상태를 그대로 가진다', () => {
    const view = projectRun([RUN[0]!, { ...base('e9', 9), type: 'run.finished', state: 'infra-failed' }]);
    expect(view.state).toBe('infra-failed');
  });

  it('타임존 오프셋이 섞여 있어도 시각 기준으로 정렬한다', () => {
    const view = projectRun([
      { ...base('e0', 0), type: 'run.started', targetId: 't' },
      { ...base('b', 0), at: '2026-11-07T09:00:05+09:00', type: 'attempt.started', attemptId: 'b', testId: 'B', attemptNo: 1 }, // = 00:00:05Z
      { ...base('a', 0), at: '2026-11-07T00:00:01.000Z', type: 'attempt.started', attemptId: 'a', testId: 'A', attemptNo: 1 },
    ]);
    expect(view.attempts.map((a) => a.attemptId)).toEqual(['a', 'b']);
  });

  it('같은 자리에 eventId 가 다른 이벤트가 둘 오면 at 이 빠른 것(같으면 eventId 가 작은 것)을 택하고, 어느 순서로 와도 같다', () => {
    const dupStart = { ...base('e0-dup', 9), type: 'run.started' as const, targetId: 'late' };
    const dupStep = { ...base('e2-dup', 2), type: 'step.recorded' as const, attemptId: 'a1', stepIndex: 0, kind: 'locator' as const, instruction: '다른 내용', modelCalls: 0, durationMs: 1 };
    const expected = projectRun(RUN);
    expect(projectRun([...RUN, dupStart, dupStep])).toEqual(expected); // e0(at 0) < e0-dup(at 9); e2 < e2-dup (같은 at, eventId 순)
    expect(projectRun([dupStep, dupStart, ...RUN])).toEqual(expected);
    expect(projectRun([...RUN, dupStart, dupStep]).attempts[0]!.steps).toHaveLength(2); // 중복 스텝이 쌓이지 않는다
  });
});
