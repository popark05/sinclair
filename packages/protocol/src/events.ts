// Runner Agent → Control Plane Ingest 이벤트. 멱등 처리를 위해 모든 이벤트는 eventId를 가진다.
import type { AttemptResult, CacheDecision } from './status.ts';

export const EVENT_SCHEMA_VERSION = 1 as const;

interface Base {
  schema: typeof EVENT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  /** ISO 8601 */
  at: string;
}

export interface RunStarted extends Base {
  type: 'run.started';
  /** 제어 평면의 Cycle. 로컬(Studio) 실행에는 없다 */
  cycleId?: string;
  targetId: string;
  /** 기기 식별자(시리얼 등). 모르면 생략한다('' 로 채우지 않는다) */
  deviceId?: string;
  /** 러너를 돌린 노드(runner-agent) 식별자. 로컬 실행에는 없다 */
  agentId?: string;
}

export interface AttemptStarted extends Base {
  type: 'attempt.started';
  attemptId: string;
  testId: string;
  attemptNo: number;
}

export interface StepRecorded extends Base {
  type: 'step.recorded';
  attemptId: string;
  stepIndex: number;
  kind: StepKind;
  instruction?: string;
  cache?: CacheDecision;
  modelCalls: number;
  durationMs: number;
  /** 이 스텝의 모델 토큰 사용량 합(Console 비용). 모델을 부르지 않은 스텝에는 없다 */
  usage?: StepUsage;
}

/** 모델 토큰 사용량. 캐시 필드는 API 가 돌려줄 때만(프롬프트 캐시 읽기·쓰기) */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
/** 스텝의 사용량: 합계 + 모델별 내역(한 스텝에 본 모델과 요약 모델·fallback 모델이 섞일 수 있어 단가가 다르다). 내역이 없으면 모델을 모르는 것 */
export interface StepUsage extends TokenUsage {
  byModel?: Record<string, TokenUsage>;
}

export const ARTIFACT_KINDS = ['screenshot', 'video', 'trace', 'ai-trace', 'device-log', 'screen-tree'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const STEP_KINDS = ['locator', 'act', 'assert', 'waitFor', 'extract'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const RUN_FINISHED_STATES = ['finished', 'cancelled', 'infra-failed'] as const;

export interface AttemptFinished extends Base {
  type: 'attempt.finished';
  attemptId: string;
  result: AttemptResult;
  errorCode?: string;
  artifacts: Array<{ kind: ArtifactKind; key: string }>;
}

export interface RunFinished extends Base {
  type: 'run.finished';
  state: (typeof RUN_FINISHED_STATES)[number];
}

export type RunEvent = RunStarted | AttemptStarted | StepRecorded | AttemptFinished | RunFinished;
export type RunEventType = RunEvent['type'];

export const RUN_EVENT_TYPES = [
  'run.started',
  'attempt.started',
  'step.recorded',
  'attempt.finished',
  'run.finished',
] as const satisfies readonly RunEventType[];
