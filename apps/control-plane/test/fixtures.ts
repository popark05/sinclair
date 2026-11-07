// 테스트 공용 이벤트 픽스처. 러너가 실제로 내는 순서의 run 하나(테스트 2개: 통과, 실패+아티팩트).
import type { RunEvent } from '@sinclair/protocol';

export const at = (s: number) => `2026-11-07T00:00:${String(s).padStart(2, '0')}.000Z`;
export const base = (eventId: string, s: number, runId = 'r1') => ({ schema: 1 as const, eventId, runId, at: at(s) });

export const RUN: RunEvent[] = [
  { ...base('e0', 0), type: 'run.started', cycleId: 'c1', targetId: 'android', deviceId: 'd1' },
  { ...base('e1', 1), type: 'attempt.started', attemptId: 'a1', testId: '로그인', attemptNo: 1 },
  { ...base('e2', 2), type: 'step.recorded', attemptId: 'a1', stepIndex: 0, kind: 'locator', instruction: 'tap 로그인', modelCalls: 0, durationMs: 10 },
  { ...base('e3', 3), type: 'step.recorded', attemptId: 'a1', stepIndex: 1, kind: 'assert', instruction: 'expect 환영', modelCalls: 0, durationMs: 5 },
  { ...base('e4', 4), type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [] },
  { ...base('e5', 5), type: 'attempt.started', attemptId: 'a2', testId: '검색', attemptNo: 1 },
  { ...base('e6', 6), type: 'step.recorded', attemptId: 'a2', stepIndex: 0, kind: 'locator', instruction: 'tap 없음 → 실패', modelCalls: 0, durationMs: 200 },
  { ...base('e7', 7), type: 'attempt.finished', attemptId: 'a2', result: 'failed', errorCode: 'not-found', artifacts: [{ kind: 'screenshot', key: 'a2.png' }] },
  { ...base('e8', 8), type: 'run.finished', state: 'finished' },
];

/** 저장소 테스트용 최소 이벤트 */
export const ev = (eventId: string, runId: string, type: 'run.started' | 'run.finished' = 'run.started', s = 0): RunEvent =>
  type === 'run.started'
    ? { ...base(eventId, s, runId), type, targetId: 't' }
    : { ...base(eventId, s, runId), type, state: 'finished' };
