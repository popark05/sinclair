// CycleStore: Cycle 과 그 아래 Run 등록 레코드. 이벤트가 아니라 별도 저장소다(EventStore 는 RunEvent 전용).
// 구현체는 test/cycle-store-suite.ts 를 통과해야 한다.

export interface CycleRecord {
  cycleId: string;
  /** 검증 대상 빌드 식별자(버전·커밋 등, 자유 문자열) */
  build: string;
  /** 타깃 id 목록. 매트릭스의 열 순서 */
  targets: string[];
  /** 필수 태그. 비면 모든 케이스가 필수 */
  requiredTags: string[];
  createdAt: string;
}

export interface RunRegistration {
  runId: string;
  cycleId: string;
  targetId: string;
  createdAt: string;
}

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
  close?(): Promise<void>;
}

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
  };
}
