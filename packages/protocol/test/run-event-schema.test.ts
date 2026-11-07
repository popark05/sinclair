// parseRunEvent: Ingest 와 러너 Reporter 가 같이 쓰는 닫힌 런타임 검증기. 통과 예시는 events.ts 의 타입과 spec 0001 의 이벤트 흐름에서 가져왔다.
import { describe, it, expect } from 'vitest';
import { parseRunEvent, type RunEvent } from '../src/index.ts';

const base = { schema: 1 as const, eventId: 'e1', runId: 'r1', at: '2026-11-07T00:00:00.000Z' };

const VALID: RunEvent[] = [
  { ...base, type: 'run.started', targetId: 'android-SM-N981N' },
  { ...base, type: 'run.started', cycleId: 'c1', targetId: 't1', deviceId: 'd1', agentId: 'node-1' },
  { ...base, type: 'attempt.started', attemptId: 'a1', testId: '설정 앱 > 열면 "설정" 제목이 보인다', attemptNo: 1 },
  { ...base, type: 'step.recorded', attemptId: 'a1', stepIndex: 0, kind: 'assert', instruction: 'expect { text="설정" } toBeVisible', modelCalls: 0, durationMs: 82 },
  { ...base, type: 'step.recorded', attemptId: 'a1', stepIndex: 1, kind: 'act', cache: 'replayed', modelCalls: 0, durationMs: 10 },
  { ...base, type: 'attempt.finished', attemptId: 'a1', result: 'failed', errorCode: 'not-found', artifacts: [{ kind: 'screenshot', key: 'a1.screenshot.png' }] },
  { ...base, type: 'run.finished', state: 'infra-failed' },
  { ...base, at: '2026-11-07T09:00:00+09:00', type: 'step.recorded', attemptId: 'a1', stepIndex: 2, kind: 'locator', instruction: '', modelCalls: 0, durationMs: 0 }, // 오프셋 타임존, 빈 instruction 허용
];

describe('parseRunEvent', () => {
  it.each(VALID.map((e) => [e.type, e] as const))('올바른 %s 이벤트를 그대로 돌려준다', (_, ev) => {
    expect(parseRunEvent(ev)).toEqual({ ok: true, event: ev });
  });

  it('객체가 아니면 거부한다', () => {
    for (const bad of [null, undefined, 'run.started', 42, []]) {
      const r = parseRunEvent(bad);
      expect(r.ok).toBe(false);
    }
  });

  it.each([
    ['모르는 type', { ...base, type: 'run.paused' }, /type/],
    ['schema 버전 불일치', { ...base, schema: 2, type: 'run.finished', state: 'finished' }, /schema/],
    ['필수 필드 누락 (attempt.finished 의 result)', { ...base, type: 'attempt.finished', attemptId: 'a1', artifacts: [] }, /result/],
    ['상수 밖의 result', { ...base, type: 'attempt.finished', attemptId: 'a1', result: 'ok', artifacts: [] }, /result/],
    ['상수 밖의 step kind', { ...base, type: 'step.recorded', attemptId: 'a1', stepIndex: 0, kind: 'click', modelCalls: 0, durationMs: 1 }, /kind/],
    ['상수 밖의 run.finished state', { ...base, type: 'run.finished', state: 'done' }, /state/],
    ['상수 밖의 cache 결정', { ...base, type: 'step.recorded', attemptId: 'a1', stepIndex: 0, kind: 'act', cache: 'hit', modelCalls: 0, durationMs: 1 }, /cache/],
    ['artifacts 원소의 kind 가 상수 밖', { ...base, type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [{ kind: 'har', key: 'x' }] }, /artifacts/],
    ['모르는 키 (닫힌 스키마)', { ...base, type: 'run.finished', state: 'finished', extra: 1 }, /extra/],
    ['필드 타입 불일치 (attemptNo 문자열)', { ...base, type: 'attempt.started', attemptId: 'a1', testId: 't', attemptNo: '1' }, /attemptNo/],
    ['at 이 ISO 8601 이 아님', { ...base, at: '어제', type: 'run.finished', state: 'finished' }, /at/],
    ['at 에 타임존이 없음', { ...base, at: '2026-11-07T00:00:00', type: 'run.finished', state: 'finished' }, /at/],
    ['artifacts 원소에 모르는 키', { ...base, type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [{ kind: 'trace', key: 'x', size: 1 }] }, /artifacts/],
    ['errorCode 가 빈 문자열', { ...base, type: 'attempt.finished', attemptId: 'a1', result: 'failed', errorCode: '', artifacts: [] }, /errorCode/],
    ['stepIndex 가 음수', { ...base, type: 'step.recorded', attemptId: 'a1', stepIndex: -1, kind: 'act', modelCalls: 0, durationMs: 1 }, /stepIndex/],
    ['attemptNo 가 0', { ...base, type: 'attempt.started', attemptId: 'a1', testId: 't', attemptNo: 0 }, /attemptNo/],
  ])('거부: %s', (_, input, pattern) => {
    const r = parseRunEvent(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(pattern);
  });

  it('오류를 모아 한 번에 돌려준다', () => {
    const r = parseRunEvent({ ...base, type: 'attempt.finished', artifacts: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2); // attemptId, result
  });
});
