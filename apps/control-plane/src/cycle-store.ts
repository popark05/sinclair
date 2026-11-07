// CycleStore: Cycle 과 그 아래 Run 등록 레코드. 이벤트가 아니라 별도 저장소다(EventStore 는 RunEvent 전용).
// 구현체는 test/cycle-store-suite.ts 를 통과해야 한다.

/** 도메인 모델의 Suite 필터: 에이전트가 돌릴 테스트 디렉터리(또는 glob)와 선택 태그 */
export interface SuiteFilter {
  tests: string;
  tags?: string[];
}

export interface CycleRecord {
  cycleId: string;
  /** 검증 대상 빌드 식별자(버전·커밋 등, 자유 문자열) */
  build: string;
  /** 타깃 id 목록. 매트릭스의 열 순서 */
  targets: string[];
  /** 필수 태그. 비면 모든 케이스가 필수 */
  requiredTags: string[];
  /** 없으면 에이전트의 기본 테스트 디렉터리 */
  suite?: SuiteFilter;
  createdAt: string;
}

/** 에이전트가 Run 을 잡은 표시. 만료되면 다른 에이전트가 가져갈 수 있다 */
export interface RunLease {
  agentId: string;
  /** ISO 8601 */
  expiresAt: string;
}

export interface RunRegistration {
  runId: string;
  cycleId: string;
  targetId: string;
  createdAt: string;
  lease?: RunLease;
}

export type HeartbeatResult = { outcome: 'ok'; expiresAt: string } | { outcome: 'not-owner' } | { outcome: 'no-run' };

export interface CycleStore {
  /** 같은 cycleId 가 있으면 'duplicate' */
  createCycle(cycle: CycleRecord): Promise<'created' | 'duplicate'>;
  getCycle(cycleId: string): Promise<CycleRecord | undefined>;
  /** 만든 순서 */
  listCycles(): Promise<CycleRecord[]>;
  /** cycle 이 없으면 'no-cycle', 같은 runId 가 있으면 'duplicate' */
  registerRun(run: RunRegistration): Promise<'registered' | 'duplicate' | 'no-cycle'>;
  /** 등록 순서 */
  runsForCycle(cycleId: string): Promise<RunRegistration[]>;
  /** 타깃이 맞고 이벤트가 없으며(hasEvents) lease 가 없거나 만료된 Run 하나를 등록 순서로 잡아 lease 를 준다. 같은 Run 을 둘이 잡을 수 없어야 한다 */
  claimRun(targetId: string, agentId: string, nowMs: number, ttlMs: number, hasEvents: (runId: string) => Promise<boolean>): Promise<RunRegistration | undefined>;
  /** 소유자만 lease 를 연장한다 */
  heartbeat(runId: string, agentId: string, nowMs: number, ttlMs: number): Promise<HeartbeatResult>;
  close?(): Promise<void>;
}

export const leaseExpired = (lease: RunLease | undefined, nowMs: number): boolean => !lease || Date.parse(lease.expiresAt) <= nowMs;
export const newLease = (agentId: string, nowMs: number, ttlMs: number): RunLease => ({ agentId, expiresAt: new Date(nowMs + ttlMs).toISOString() });

export function createMemoryCycleStore(): CycleStore {
  const cycles = new Map<string, CycleRecord>();
  const runs = new Map<string, RunRegistration>();
  return {
    async createCycle(cycle) {
      if (cycles.has(cycle.cycleId)) return 'duplicate';
      cycles.set(cycle.cycleId, structuredClone(cycle));
      return 'created';
    },
    async getCycle(cycleId) {
      const c = cycles.get(cycleId);
      return c ? structuredClone(c) : undefined;
    },
    async listCycles() {
      return [...cycles.values()].map((c) => structuredClone(c));
    },
    async registerRun(run) {
      if (!cycles.has(run.cycleId)) return 'no-cycle';
      if (runs.has(run.runId)) return 'duplicate';
      runs.set(run.runId, structuredClone(run));
      return 'registered';
    },
    async runsForCycle(cycleId) {
      return [...runs.values()].filter((r) => r.cycleId === cycleId).map((r) => structuredClone(r));
    },
    async claimRun(targetId, agentId, nowMs, ttlMs, hasEvents) {
      for (const r of runs.values()) {
        if (r.targetId !== targetId || !leaseExpired(r.lease, nowMs)) continue;
        if (await hasEvents(r.runId)) continue;
        if (!leaseExpired(r.lease, nowMs)) continue; // hasEvents 를 기다리는 사이 다른 호출이 잡았을 수 있다
        r.lease = newLease(agentId, nowMs, ttlMs);
        return structuredClone(r);
      }
      return undefined;
    },
    async heartbeat(runId, agentId, nowMs, ttlMs) {
      const r = runs.get(runId);
      if (!r) return { outcome: 'no-run' };
      if (r.lease?.agentId !== agentId) return { outcome: 'not-owner' };
      r.lease = newLease(agentId, nowMs, ttlMs);
      return { outcome: 'ok', expiresAt: r.lease.expiresAt };
    },
  };
}
