// Run/Attempt 상태와 Verdict. specs/0001-architecture.md "백엔드 도메인 모델" 절과 일치해야 한다.

export const ATTEMPT_RESULTS = ['passed', 'failed', 'blocked', 'skipped'] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

/** 에이전트 스텝에 대해 러너가 내린 캐시 결정 */
export const CACHE_DECISIONS = ['replayed', 'handed-off', 'recorded', 'live'] as const;
export type CacheDecision = (typeof CACHE_DECISIONS)[number];

export const RUN_STATES = ['queued', 'leasing', 'running', 'finished', 'cancelled', 'infra-failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const CYCLE_STATES = ['draft', 'running', 'finished', 'expired', 'cancelled'] as const;
export type CycleState = (typeof CYCLE_STATES)[number];

export const DEVICE_STATES = ['idle', 'leased', 'offline', 'untrusted'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

export const ISSUE_KINDS = ['app-bug', 'test-bug', 'flaky', 'env'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** TestCase × 타깃의 최종 판정 */
export type CaseVerdict = 'passed' | 'passed-flaky' | 'failed' | 'blocked' | 'skipped' | 'waived';

/** Cycle 수준 판정 */
export type CycleVerdict = 'verified' | 'blocked' | 'incomplete';

export const NETWORK_MODES = ['direct', 'capture', 'mock'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
