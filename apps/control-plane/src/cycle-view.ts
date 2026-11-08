// Cycle 조회 조립: 등록 레코드 + 각 run 의 이벤트 투영 → computeCycle. HTTP 와 (앞으로) Console 이 같은 뷰를 쓴다.
import type { CycleStore, RunRegistration } from './cycle-store.ts';
import { leaseExpired } from './cycle-store.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';
import { computeCycle, DEFAULT_RETRY_LIMIT, type CycleView } from './verdict.ts';

/** 합성 종료 이벤트 id. 같은 Run 을 몇 번(두 서버가 동시에라도) 처리해도 Ingest 가 하나로 받는다 */
export const abandonedEventId = (runId: string): string => `abandoned:${runId}`;
/** 대체 Run id. 결정적이라 두 서버가 동시에 정리해도 registerRun 이 한 번만 성공하고, 등록 뒤 죽어도 다음 정리가 같은 id 로 이어 붙인다 */
export const replacementRunId = (runId: string): string => `retry:${runId}`;

export interface SweepOptions {
  nowMs: number;
  /** lease 만료 뒤 이만큼 더 지나야 버려진 것으로 본다. 기본은 lease TTL 과 같은 60초: heartbeat 를 두 번 놓치고 TTL 까지 지난 뒤에도 한 번 더 기다려 네트워크 흔들림과 진짜 죽음을 가른다 */
  graceMs: number;
}

export interface SweepResult { abandoned: string[]; replacements: Array<{ runId: string; replaces: string; targetId: string }> }

/** 모든 Cycle 에 대해 sweepAbandoned. 클레임 직전에 불러 대체 Run 이 같은 클레임에서 잡히게 한다. 후보가 없는 Cycle 은 이벤트를 읽지 않으므로 Cycle 이 쌓여도 레코드 조회 비용만 든다 */
export async function sweepAllAbandoned(events: EventStore, cycles: CycleStore, opts: SweepOptions): Promise<SweepResult> {
  const total: SweepResult = { abandoned: [], replacements: [] };
  for (const c of await cycles.listCycles()) {
    const r = await sweepAbandoned(events, cycles, c.cycleId, opts);
    total.abandoned.push(...r.abandoned); total.replacements.push(...r.replacements);
  }
  return total;
}

/**
 * 버려진 Run 정리: 클레임돼(lease 보유) 이벤트는 있는데 끝나지 않았고 lease 만료 뒤 유예까지 지난 Run 을 합성 `run.finished infra-failed` 로 닫고,
 * Cycle 의 retryLimit 안이면 같은 타깃의 대체 Run 을 등록한다. 클레임·조회 때 불린다(별도 스케줄러 없음).
 * lease 없이 보고되는 Run(`run --run` 처럼 에이전트가 스스로 등록·실행)은 대상이 아니다: 서버가 아는 시각은 이벤트의 생산 시각 `at` 뿐이라,
 * 스풀이 늦게 비워지는 정상 상황을 죽음으로 오판해 `run.finished` 가 둘인 Run 을 만들 수 있다. 그런 Run 은 그 에이전트가 끝까지 책임진다.
 */
export async function sweepAbandoned(events: EventStore, cycles: CycleStore, cycleId: string, opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { abandoned: [], replacements: [] };
  const cycle = await cycles.getCycle(cycleId);
  if (!cycle) return result;
  const regs = await cycles.runsForCycle(cycleId);
  const limit = cycle.retryLimit ?? DEFAULT_RETRY_LIMIT;
  const used = new Map<string, number>();
  for (const r of regs) if (r.replaces) used.set(r.targetId, (used.get(r.targetId) ?? 0) + 1);

  for (const reg of regs) {
    if (reg.replacedBy || !reg.lease) continue;
    // 싼 검사(레코드)로 먼저 거른 뒤에만 이벤트를 읽는다
    const staleSince = Date.parse(reg.lease.expiresAt);
    if (!leaseExpired(reg.lease, opts.nowMs) || !Number.isFinite(staleSince) || opts.nowMs - staleSince < opts.graceMs) continue;
    const stored = await events.eventsForRun(reg.runId);
    if (stored.length === 0) continue; // 아직 시작도 안 한 Run 은 클레임 규칙(lease 만료 재클레임)이 다룬다
    const view = projectRun(stored);
    if (view.state === 'finished' || view.state === 'cancelled' || view.state === 'infra-failed') continue;

    const abandonedAt = new Date(opts.nowMs).toISOString();
    await events.append({ schema: 1, eventId: abandonedEventId(reg.runId), runId: reg.runId, at: abandonedAt, type: 'run.finished', state: 'infra-failed' });
    result.abandoned.push(reg.runId);
    // 앞선 정리가 등록까지 하고 죽었으면 한도와 무관하게 표시만 마친다
    const existing = regs.find((r) => r.replaces === reg.runId);
    if (existing) { await cycles.markReplaced(reg.runId, existing.runId, abandonedAt); continue; }
    if ((used.get(reg.targetId) ?? 0) >= limit) continue; // 한도 소진: infra-failed 로 남아 Cycle 은 blocked
    // 등록을 먼저, 표시를 나중에: 둘 사이에 죽어도 다음 정리가 같은 id 로 다시 와서 표시만 마친다(반대 순서면 존재하지 않는 Run 을 가리킨 채 영영 건너뛴다)
    const replacement: RunRegistration = { runId: replacementRunId(reg.runId), cycleId, targetId: reg.targetId, createdAt: abandonedAt, replaces: reg.runId };
    const registered = await cycles.registerRun(replacement);
    await cycles.markReplaced(reg.runId, replacement.runId, abandonedAt);
    if (registered !== 'registered') continue; // 다른 서버가 먼저 만들었다
    used.set(reg.targetId, (used.get(reg.targetId) ?? 0) + 1);
    result.replacements.push({ runId: replacement.runId, replaces: reg.runId, targetId: reg.targetId });
  }
  return result;
}

export interface CycleViewWithWarnings extends CycleView {
  /** 등록과 이벤트가 어긋난 경우(run.started 의 cycleId/targetId 가 등록과 다름). 판정은 등록을 따른다 */
  warnings?: string[];
}

export async function buildCycleView(events: EventStore, cycles: CycleStore, cycleId: string): Promise<CycleViewWithWarnings | undefined> {
  const cycle = await cycles.getCycle(cycleId);
  if (!cycle) return undefined;
  const regs = await cycles.runsForCycle(cycleId);
  const views: RunView[] = [];
  const warnings: string[] = [];
  for (const r of regs) {
    const stored = await events.eventsForRun(r.runId);
    if (stored.length === 0) continue;
    const view = projectRun(stored);
    if (view.cycleId !== undefined && view.cycleId !== r.cycleId) warnings.push(`run ${r.runId}: 이벤트의 cycleId(${view.cycleId})가 등록(${r.cycleId})과 다름`);
    if (view.targetId !== undefined && view.targetId !== r.targetId) warnings.push(`run ${r.runId}: 이벤트의 targetId(${view.targetId})가 등록(${r.targetId})과 다름`);
    // 기기 lease 가 있으면 러너가 실제로 쓴 기기와 맞아야 한다(다르면 lease 가 지키는 독점이 깨진 것)
    if (view.deviceId !== undefined && r.lease?.deviceId !== undefined && view.deviceId !== r.lease.deviceId) warnings.push(`run ${r.runId}: 이벤트의 deviceId(${view.deviceId})가 lease 된 기기(${r.lease.deviceId})와 다름`);
    views.push(view);
  }
  return { ...computeCycle(cycle, regs, views), ...(warnings.length ? { warnings } : {}) };
}
