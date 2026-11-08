// RunEvent 런타임 검증기. 러너 Reporter 와 control-plane Ingest 가 같은 검증을 쓴다.
// 닫힌 스키마: 모르는 type·키, 빠진 필수 필드, 상수 밖의 값은 모두 거부한다. 오류는 모아서 한 번에 돌려준다.
import { ARTIFACT_KINDS, EVENT_SCHEMA_VERSION, RUN_FINISHED_STATES, STEP_KINDS, type AttemptFinished, type AttemptStarted, type RunEvent, type RunEventType, type RunFinished, type RunStarted, type StepRecorded, type StepUsage } from './events.ts';
import { ATTEMPT_RESULTS, CACHE_DECISIONS } from './status.ts';

export type ParseResult = { ok: true; event: RunEvent } | { ok: false; errors: string[] };

type FieldRule = { required: boolean; check: (v: unknown) => string | undefined };
type BaseKey = 'schema' | 'eventId' | 'runId' | 'at' | 'type';
/** 이벤트 인터페이스의 필드마다 규칙 하나. 인터페이스에 필드를 더하면 여기서 컴파일 오류가 나 검증기와 타입이 어긋나지 않는다 */
type Rules<E extends RunEvent> = Record<Exclude<keyof E, BaseKey>, FieldRule>;

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? undefined : '비어 있지 않은 문자열이어야 함');
const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? undefined : '0 이상의 정수여야 함');
const oneOf = (values: readonly string[]) => (v: unknown) => (typeof v === 'string' && values.includes(v) ? undefined : `${values.join('|')} 중 하나여야 함`);
// 타임존(Z 또는 ±hh:mm)을 요구한다. 없으면 runner-agent 와 Ingest 가 서로 다른 로컬 시간으로 읽는다
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(v) ? undefined : 'ISO 8601(타임존 포함)이어야 함');
const artifacts = (v: unknown) => {
  if (!Array.isArray(v)) return '배열이어야 함';
  for (const [i, a] of v.entries()) {
    if (!isRecord(a)) return `[${i}] 객체여야 함`;
    const keys = Object.keys(a).sort();
    if (keys.join(',') !== 'key,kind') return `[${i}] kind/key 만 가져야 함`;
    if (oneOf(ARTIFACT_KINDS)(a.kind)) return `[${i}].kind 는 ${ARTIFACT_KINDS.join('|')} 중 하나여야 함`;
    if (str(a.key)) return `[${i}].key 는 비어 있지 않은 문자열이어야 함`;
  }
  return undefined;
};

const USAGE: Record<keyof StepUsage, FieldRule> = {
  inputTokens: { required: true, check: int }, outputTokens: { required: true, check: int },
  cacheReadTokens: { required: false, check: int }, cacheWriteTokens: { required: false, check: int },
};
const usage = (v: unknown) => {
  if (!isRecord(v)) return '객체여야 함';
  const problems: string[] = [];
  for (const [key, rule] of Object.entries(USAGE)) {
    if (!Object.hasOwn(v, key)) { if (rule.required) problems.push(`${key} 누락`); continue; }
    const p = rule.check(v[key]);
    if (p) problems.push(`${key} ${p}`);
  }
  for (const key of Object.keys(v)) if (!Object.hasOwn(USAGE, key)) problems.push(`${key} 모르는 키`);
  return problems.length ? problems.join(', ') : undefined;
};

const BASE: Record<string, FieldRule> = {
  schema: { required: true, check: (v) => (v === EVENT_SCHEMA_VERSION ? undefined : `${EVENT_SCHEMA_VERSION} 이어야 함`) },
  eventId: { required: true, check: str },
  runId: { required: true, check: str },
  at: { required: true, check: iso },
  type: { required: true, check: str },
};

const BY_TYPE: Record<RunEventType, Record<string, FieldRule>> = {
  'run.started': { cycleId: { required: false, check: str }, targetId: { required: true, check: str }, deviceId: { required: false, check: str }, agentId: { required: false, check: str } } satisfies Rules<RunStarted>,
  'attempt.started': { attemptId: { required: true, check: str }, testId: { required: true, check: str }, attemptNo: { required: true, check: (v) => (Number.isInteger(v) && (v as number) >= 1 ? undefined : '1 이상의 정수여야 함') } } satisfies Rules<AttemptStarted>,
  'step.recorded': {
    attemptId: { required: true, check: str }, stepIndex: { required: true, check: int }, kind: { required: true, check: oneOf(STEP_KINDS) },
    // instruction 은 빈 문자열 허용(지시가 없는 스텝). cache 는 에이전트 스텝에만 있다
    instruction: { required: false, check: (v) => (typeof v === 'string' ? undefined : '문자열이어야 함') }, cache: { required: false, check: oneOf(CACHE_DECISIONS) },
    modelCalls: { required: true, check: int }, durationMs: { required: true, check: int }, usage: { required: false, check: usage },
  } satisfies Rules<StepRecorded>,
  'attempt.finished': { attemptId: { required: true, check: str }, result: { required: true, check: oneOf(ATTEMPT_RESULTS) }, errorCode: { required: false, check: str }, artifacts: { required: true, check: artifacts } } satisfies Rules<AttemptFinished>,
  'run.finished': { state: { required: true, check: oneOf(RUN_FINISHED_STATES) } } satisfies Rules<RunFinished>,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseRunEvent(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, errors: ['이벤트는 객체여야 함'] };
  const errors: string[] = [];
  const type = input.type;
  const typeRules = typeof type === 'string' && Object.hasOwn(BY_TYPE, type) ? BY_TYPE[type as RunEventType] : undefined;
  if (!typeRules) errors.push(`type: 모르는 이벤트 유형 ${JSON.stringify(type)}`);
  const rules = { ...BASE, ...typeRules };
  for (const [key, rule] of Object.entries(rules)) {
    if (key === 'type' && !typeRules) continue;
    if (!(key in input)) { if (rule.required) errors.push(`${key}: 필수 필드 누락`); continue; }
    const problem = rule.check(input[key]);
    if (problem) errors.push(`${key}: ${problem}`);
  }
  for (const key of Object.keys(input)) if (!(key in rules)) errors.push(`${key}: 모르는 키`);
  // 모든 규칙을 통과한 입력만 RunEvent 로 본다(검증기와 타입의 연결은 위 Rules<E> 가 보장). 입력 객체를 복사하지 않고 그대로 돌려준다
  return errors.length ? { ok: false, errors } : { ok: true, event: input as unknown as RunEvent };
}
