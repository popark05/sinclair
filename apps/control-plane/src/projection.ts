// Run/Attempt 투영: 저장된 RunEvent 에서 계산한다(투영은 저장하지 않는다). 도착 순서와 무관하게 같은 결과가 나와야 한다.
// 정렬·선택은 이벤트의 내용(at, eventId, stepIndex)으로만 한다. 배열 순서(도착 순서)는 쓰지 않는다.
// 같은 자리(run.started, attempt.started, attempt.finished, 같은 stepIndex)에 eventId 가 다른 이벤트가 둘 오면
// at 이 빠른 것, 같으면 eventId 가 작은 것을 택한다. Reporter 는 재시도에 같은 eventId 를 쓰므로 정상 경로에서는 생기지 않는다.
import type { ArtifactKind, AttemptResult, RunEvent, RunState, StepKind, CacheDecision, StepUsage } from '@sinclair/protocol';

export interface StepView {
  stepIndex: number;
  kind: StepKind;
  instruction?: string;
  cache?: CacheDecision;
  modelCalls: number;
  durationMs: number;
  /** 모델 스텝의 토큰 사용량(Console 비용) */
  usage?: StepUsage;
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
  agentId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** startedAt(없으면 finishedAt) 시각 순, 같으면 attemptId 순 */
  attempts: AttemptView[];
}

/** 이벤트 시각 비교. ISO 문자열 비교는 타임존 오프셋이 섞이면 틀리므로 파싱해서 비교한다 */
function byTime(a: RunEvent, b: RunEvent): number {
  return Date.parse(a.at) - Date.parse(b.at) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}

/** 같은 자리의 후보 중 하나를 고른다: at 이 빠른 것, 같으면 eventId 가 작은 것 */
function pick<E extends RunEvent>(candidates: E[]): E | undefined {
  return [...candidates].sort(byTime)[0];
}

/** undefined 값을 뺀 객체. 응답 JSON 의 키 순서가 도착 순서에 흔들리지 않도록 호출자가 고정된 순서로 넘긴다 */
function defined<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

type ByType<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

export function projectRun(events: RunEvent[]): RunView {
  const runId = events[0]?.runId ?? '';
  const of = <T extends RunEvent['type']>(type: T): ByType<T>[] => events.filter((e): e is ByType<T> => e.type === type);
  const started = pick(of('run.started'));
  const finished = pick(of('run.finished'));

  const attemptIds = new Set<string>();
  for (const e of events) if ('attemptId' in e) attemptIds.add(e.attemptId);

  const attempts = [...attemptIds].map((attemptId): AttemptView => {
    const s = pick(of('attempt.started').filter((e) => e.attemptId === attemptId));
    const f = pick(of('attempt.finished').filter((e) => e.attemptId === attemptId));
    const stepsByIndex = new Map<number, ByType<'step.recorded'>[]>();
    for (const e of of('step.recorded')) if (e.attemptId === attemptId) stepsByIndex.set(e.stepIndex, [...(stepsByIndex.get(e.stepIndex) ?? []), e]);
    const steps = [...stepsByIndex.keys()].sort((a, b) => a - b).map((i) => {
      const e = pick(stepsByIndex.get(i)!)!;
      return defined<StepView>({ stepIndex: e.stepIndex, kind: e.kind, instruction: e.instruction, cache: e.cache, modelCalls: e.modelCalls, durationMs: e.durationMs, usage: e.usage });
    });
    return defined<AttemptView>({
      attemptId, testId: s?.testId, attemptNo: s?.attemptNo, startedAt: s?.at, finishedAt: f?.at,
      result: f?.result, errorCode: f?.errorCode, artifacts: f?.artifacts ?? [], steps,
    });
  });
  attempts.sort((x, y) => {
    const tx = Date.parse(x.startedAt ?? x.finishedAt ?? '') || 0;
    const ty = Date.parse(y.startedAt ?? y.finishedAt ?? '') || 0;
    return tx - ty || (x.attemptId < y.attemptId ? -1 : x.attemptId > y.attemptId ? 1 : 0);
  });

  return defined<RunView>({
    runId,
    state: finished ? finished.state : started ? 'running' : 'queued',
    cycleId: started?.cycleId, targetId: started?.targetId, deviceId: started?.deviceId, agentId: started?.agentId,
    startedAt: started?.at, finishedAt: finished?.at, attempts,
  });
}
