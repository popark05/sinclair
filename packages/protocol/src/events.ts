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
  cycleId: string;
  targetId: string;
  deviceId: string;
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
  kind: 'locator' | 'act' | 'assert' | 'waitFor' | 'extract';
  instruction?: string;
  cache?: CacheDecision;
  modelCalls: number;
  durationMs: number;
}

export interface AttemptFinished extends Base {
  type: 'attempt.finished';
  attemptId: string;
  result: AttemptResult;
  errorCode?: string;
  artifacts: Array<{ kind: 'screenshot' | 'video' | 'trace' | 'ai-trace' | 'device-log' | 'screen-tree'; key: string }>;
}

export interface RunFinished extends Base {
  type: 'run.finished';
  state: 'finished' | 'cancelled' | 'infra-failed';
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
