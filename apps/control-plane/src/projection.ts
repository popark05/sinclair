// Run/Attempt 투영: 저장된 RunEvent 에서 계산한다(투영은 저장하지 않는다). 도착 순서와 무관하게 같은 결과가 나와야 한다.
// 정렬은 이벤트의 at·stepIndex 같은 내용으로만 한다. 도착 순서(배열 순서)는 쓰지 않는다.
import type { ArtifactKind, AttemptResult, RunEvent, RunState, StepKind, CacheDecision } from '@sinclair/protocol';

export interface StepView {
  stepIndex: number;
  kind: StepKind;
  instruction?: string;
  cache?: CacheDecision;
  modelCalls: number;
  durationMs: number;
}

export interface AttemptView {
  attemptId: string;
  /** attempt.started 가 아직 없으면 비어 있다 */
  testId?: string;
  attemptNo?: number;
  startedAt?: string;
  finishedAt?: string;
  /** attempt.finished 가 아직 없으면 비어 있다 */
  result?: AttemptResult;
  errorCode?: string;
  artifacts: Array<{ kind: ArtifactKind; key: string }>;
  steps: StepView[];
}

export interface RunView {
  runId: string;
  /** run.started 전 queued, 그 뒤 running, run.finished 의 state 로 끝난다 */
  state: RunState;
  cycleId?: string;
  targetId?: string;
  deviceId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** startedAt(없으면 finishedAt) 순, 같으면 attemptId 순 */
  attempts: AttemptView[];
}

export function projectRun(events: RunEvent[]): RunView {
  const runId = events[0]?.runId ?? '';
  const view: RunView = { runId, state: 'queued', attempts: [] };
  const attempts = new Map<string, AttemptView>();
  const attempt = (id: string): AttemptView => {
    let a = attempts.get(id);
    if (!a) { a = { attemptId: id, artifacts: [], steps: [] }; attempts.set(id, a); }
    return a;
  };

  for (const e of events) {
    switch (e.type) {
      case 'run.started':
        Object.assign(view, { targetId: e.targetId, startedAt: e.at, ...(e.cycleId ? { cycleId: e.cycleId } : {}), ...(e.deviceId ? { deviceId: e.deviceId } : {}) });
        if (view.state === 'queued') view.state = 'running';
        break;
      case 'run.finished':
        view.state = e.state;
        view.finishedAt = e.at;
        break;
      case 'attempt.started':
        Object.assign(attempt(e.attemptId), { testId: e.testId, attemptNo: e.attemptNo, startedAt: e.at });
        break;
      case 'step.recorded': {
        const step: StepView = { stepIndex: e.stepIndex, kind: e.kind, modelCalls: e.modelCalls, durationMs: e.durationMs, ...(e.instruction !== undefined ? { instruction: e.instruction } : {}), ...(e.cache ? { cache: e.cache } : {}) };
        attempt(e.attemptId).steps.push(step);
        break;
      }
      case 'attempt.finished':
        Object.assign(attempt(e.attemptId), { finishedAt: e.at, result: e.result, artifacts: e.artifacts, ...(e.errorCode ? { errorCode: e.errorCode } : {}) });
        break;
    }
  }

  for (const a of attempts.values()) a.steps.sort((x, y) => x.stepIndex - y.stepIndex);
  view.attempts = [...attempts.values()].sort((x, y) => {
    const tx = x.startedAt ?? x.finishedAt ?? '';
    const ty = y.startedAt ?? y.finishedAt ?? '';
    return tx < ty ? -1 : tx > ty ? 1 : x.attemptId < y.attemptId ? -1 : x.attemptId > y.attemptId ? 1 : 0;
  });
  // 필드 순서를 고정해 toEqual·JSON 비교가 도착 순서에 흔들리지 않게 한다
  view.attempts = view.attempts.map((a) => ({
    attemptId: a.attemptId, ...(a.testId !== undefined ? { testId: a.testId } : {}), ...(a.attemptNo !== undefined ? { attemptNo: a.attemptNo } : {}),
    ...(a.startedAt ? { startedAt: a.startedAt } : {}), ...(a.finishedAt ? { finishedAt: a.finishedAt } : {}),
    ...(a.result ? { result: a.result } : {}), ...(a.errorCode ? { errorCode: a.errorCode } : {}), artifacts: a.artifacts, steps: a.steps,
  }));
  return view;
}
