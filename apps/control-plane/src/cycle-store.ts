// CycleStore: Cycle 과 그 아래 Run 등록 레코드. 이벤트가 아니라 별도 저장소다(EventStore 는 RunEvent 전용).
// 구현체는 test/cycle-store-suite.ts 를 통과해야 한다.
import type { TargetSelector } from '@sinclair/protocol';

/** 도메인 모델의 Suite 필터: 에이전트가 돌릴 테스트 디렉터리(또는 glob)와 선택 태그 */
export interface SuiteFilter {
  tests: string;
  tags?: string[];
  /** failed 테스트를 다시 돌리는 횟수(0~5). 에이전트의 --retries 보다 우선한다 */
  retries?: number;
}

export interface CycleRecord {
  cycleId: string;
  /** 검증 대상 빌드 식별자(버전·커밋 등, 자유 문자열) */
  build: string;
  /** 타깃 id 목록. 매트릭스의 열 순서 */
  targets: string[];
  /** 필수 태그. 비면 모든 케이스가 필수 */
  requiredTags: string[];
  /** 조건 타깃(device-fleet 03): 타깃 id → 기기 선택 조건. 여기 없는 타깃은 이름 타깃(그 이름을 선언한 노드가 채운다) */
  targetSelectors?: Record<string, TargetSelector>;
  /** 없으면 에이전트의 기본 테스트 디렉터리 */
  suite?: SuiteFilter;
  /** 타깃당 버려진 Run 을 대체 Run 으로 다시 돌릴 수 있는 횟수(기본 1). 0 이면 대체 없음 */
  retryLimit?: number;
  createdAt: string;
}

/** 에이전트가 Run 을 잡은 표시. 만료되면 다른 에이전트가 가져갈 수 있다 */
export interface RunLease {
  agentId: string;
  /** ISO 8601 */
  expiresAt: string;
  /** 기기 lease: 이 Run 이 독점해 쓰는 기기(device-fleet 02). Run lease 와 수명이 같다(heartbeat 로 함께 연장, 만료·대체·Run 종료로 함께 풀림). 기기 없이 클레임한 구버전 에이전트면 없다 */
  deviceId?: string;
  /** 클레임한 시각(heartbeat 로 바뀌지 않는다). 맞는 기기가 여럿일 때 "가장 오래 쉰 기기 먼저" 를 고르는 데 쓴다(device-fleet 03) */
  claimedAt?: string;
}

/** 클레임 옵션. devices 가 있으면 그중 쓰지 않는 기기를 lease 에 싣고, 하나도 없으면 Run 을 주지 않는다 */
export interface ClaimOptions {
  devices?: readonly string[];
  /** 끝난 것으로 아는 Run(이벤트에 run.finished 가 있음). 그 Run 의 기기는 lease 가 남아 있어도 풀린 것으로 본다. 끝남은 되돌아가지 않으므로 오래된 집합이어도 안전하다 */
  finishedRuns?: ReadonlySet<string>;
  /** 이 Run 을 이 클레임에 줄 수 있는지(device-fleet 03): false = 못 줌, true = 후보 아무 기기나(또는 기기 없이), 배열 = 이 기기들만(조건 타깃에 맞는 기기).
   *  비동기라 SQLite 트랜잭션 밖에서 부른다 */
  eligible?: (reg: RunRegistration) => Promise<boolean | readonly string[]>;
}

export interface DeviceLease { deviceId: string; runId: string; agentId: string; expiresAt: string }

/** 기기가 바쁜 조건: 그 기기를 가진 Run lease 가 만료 전이고, Run 이 대체되지 않았다(끝났는지는 호출자가 finishedRuns 로 걸러 낸다). 두 저장소가 같은 규칙을 쓴다 */
export function activeDeviceLeases(regs: Iterable<RunRegistration>, nowMs: number): DeviceLease[] {
  const out: DeviceLease[] = [];
  for (const r of regs) {
    if (!r.lease?.deviceId || r.replacedBy || leaseExpired(r.lease, nowMs)) continue;
    out.push({ deviceId: r.lease.deviceId, runId: r.runId, agentId: r.lease.agentId, expiresAt: r.lease.expiresAt });
  }
  return out;
}

/** 기기마다 마지막으로 클레임된 시각(만료·종료와 무관하게 lease 에 남은 claimedAt 중 가장 늦은 것).
 *  "가장 오래 쉰" 은 정확히는 "가장 오래전에 클레임된" 이다(끝난 시각이 아니다). Run 이 만료 뒤 다른 기기로 다시 클레임되면 앞 기기의 기록은 lease 와 함께 사라진다 — 순서에만 쓰는 값이라 허용한다 */
export function lastClaimedByDevice(regs: Iterable<RunRegistration>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of regs) {
    const d = r.lease?.deviceId, t = r.lease?.claimedAt;
    if (d && t && (out.get(d) ?? '') < t) out.set(d, t);
  }
  return out;
}

/** 후보 중 빈 기기 하나. devices 가 없으면(구버전) null = 기기 없이, 고를 빈 기기가 없으면 undefined = 주지 않음.
 *  allowed 가 있으면 그 기기들 중에서만(조건 타깃). lastClaimed 가 있으면 가장 오래 쉰 기기 먼저 — 한 번도 안 쓴 기기, 그다음 마지막 클레임이 이른 순, 같으면 후보 순서.
 *  오래 쉰 기기를 먼저 쓰면 한 기기에만 Run 이 몰리지 않고 노드의 기기들이 고르게 돈다 */
export function pickDevice(regs: Iterable<RunRegistration>, nowMs: number, opts: ClaimOptions | undefined, allowed?: readonly string[], lastClaimed?: ReadonlyMap<string, string>): string | null | undefined {
  if (!opts?.devices) return null;
  const busy = new Set(activeDeviceLeases(regs, nowMs).filter((l) => !opts.finishedRuns?.has(l.runId)).map((l) => l.deviceId));
  const free = opts.devices.filter((d) => !busy.has(d) && (!allowed || allowed.includes(d)));
  if (!lastClaimed) return free[0];
  return free
    .map((d, i) => ({ d, i, t: lastClaimed.get(d) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t === undefined ? -1 : b.t === undefined ? 1 : a.t < b.t ? -1 : 1))[0]?.d;
}

export interface RunRegistration {
  runId: string;
  cycleId: string;
  targetId: string;
  createdAt: string;
  lease?: RunLease;
  /** 이 Run 이 대체하는 Run(버려졌거나 취소됨) */
  replaces?: string;
  /** 대체한 까닭. 없으면 버려진 Run 의 대체(retryLimit 을 쓴다). cancelled = 취소로 끝난 Run 을 다시 등록한 것(retryLimit 을 쓰지 않는다, followups 05) */
  replaceReason?: 'cancelled';
  /** 버려지거나 취소돼 이 Run 으로 대체됨(Verdict 에서 제외) */
  replacedBy?: string;
  /** 버려진 것으로 정리된 시각. 취소로 대체된 Run 에는 없다 */
  abandonedAt?: string;
}

/** replaced: 버려진 Run 으로 정리돼 대체 Run 이 생겼다. lease 소유자가 그대로여도 연장하지 않는다 — 원래 에이전트가 이걸 받고 취소해야 두 Run 이 같은 몫을 계속 보고하지 않는다 */
export type HeartbeatResult = { outcome: 'ok'; expiresAt: string } | { outcome: 'not-owner' } | { outcome: 'no-run' } | { outcome: 'replaced'; replacedBy: string };

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
  /** targetId 가 없으면 모든 타깃의 Run 을 등록 순서로 보고 opts.eligible 로 거른다(device-fleet 03) */
  claimRun(targetId: string | undefined, agentId: string, nowMs: number, ttlMs: number, hasEvents: (runId: string) => Promise<boolean>, opts?: ClaimOptions): Promise<RunRegistration | undefined>;
  /** 지금 바쁜 기기들(activeDeviceLeases 규칙, Run 종료는 모름). Fleet 의 leased 와 클레임 전 끝난 Run 거르기에 쓴다 */
  deviceLeases(nowMs: number): Promise<DeviceLease[]>;
  /** 소유자만 lease 를 연장한다 */
  heartbeat(runId: string, agentId: string, nowMs: number, ttlMs: number): Promise<HeartbeatResult>;
  /** 대체 표시. 버려진 Run 이면 abandonedAt 을 함께 남긴다. 이미 표시돼 있으면 'already'(그 값 유지), 없으면 'no-run' */
  markReplaced(runId: string, replacedBy: string, abandonedAt?: string): Promise<'marked' | 'already' | 'no-run'>;
  close?(): Promise<void>;
}

export const leaseExpired = (lease: RunLease | undefined, nowMs: number): boolean => !lease || Date.parse(lease.expiresAt) <= nowMs;
export const newLease = (agentId: string, nowMs: number, ttlMs: number, deviceId?: string, claimedAt?: string): RunLease => ({ agentId, expiresAt: new Date(nowMs + ttlMs).toISOString(), ...(deviceId ? { deviceId } : {}), ...(claimedAt ? { claimedAt } : {}) });

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
    async claimRun(targetId, agentId, nowMs, ttlMs, hasEvents, opts) {
      if (pickDevice(runs.values(), nowMs, opts) === undefined) return undefined; // 빈 기기가 없으면 후보를 볼 필요도 없다
      for (const r of runs.values()) {
        if ((targetId !== undefined && r.targetId !== targetId) || !leaseExpired(r.lease, nowMs)) continue; // 사전 필터
        if (await hasEvents(r.runId)) continue;
        const ok = opts?.eligible ? await opts.eligible(structuredClone(r)) : true;
        if (ok === false) continue;
        if (!leaseExpired(r.lease, nowMs)) continue; // 위 await 사이에 다른 호출이 잡았으면 넘어간다
        // 기기도 await 뒤에 다시 고른다(같은 프로세스의 다른 클레임이 그 사이 가져갔을 수 있다). 여기부터 반환까지는 동기라 끼어들 수 없다
        const device = pickDevice(runs.values(), nowMs, opts, ok === true ? undefined : ok, opts?.devices && opts.devices.length > 1 ? lastClaimedByDevice(runs.values()) : undefined);
        if (device === undefined) continue; // 이 Run 에 맞는 빈 기기가 없다: 다른 타깃의 Run 은 다른 기기로 받을 수 있다
        r.lease = newLease(agentId, nowMs, ttlMs, device ?? undefined, device ? new Date(nowMs).toISOString() : undefined);
        return structuredClone(r);
      }
      return undefined;
    },
    async deviceLeases(nowMs) {
      return activeDeviceLeases(runs.values(), nowMs);
    },
    async heartbeat(runId, agentId, nowMs, ttlMs) {
      const r = runs.get(runId);
      if (!r) return { outcome: 'no-run' };
      if (r.replacedBy) return { outcome: 'replaced', replacedBy: r.replacedBy };
      if (r.lease?.agentId !== agentId) return { outcome: 'not-owner' };
      r.lease = newLease(agentId, nowMs, ttlMs, r.lease.deviceId, r.lease.claimedAt);
      return { outcome: 'ok', expiresAt: r.lease.expiresAt };
    },
    async markReplaced(runId, replacedBy, abandonedAt) {
      const r = runs.get(runId);
      if (!r) return 'no-run';
      if (r.replacedBy) return 'already';
      r.replacedBy = replacedBy;
      if (abandonedAt) r.abandonedAt = abandonedAt;
      return 'marked';
    },
  };
}
