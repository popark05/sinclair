// Cycle 조회 조립: 등록 레코드 + 각 run 의 이벤트 투영 → computeCycle. HTTP 와 (앞으로) Console 이 같은 뷰를 쓴다.
import { randomUUID } from 'node:crypto';
import type { CycleStore, RunRegistration } from './cycle-store.ts';
import { leaseExpired } from './cycle-store.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';
import { computeCycle, DEFAULT_RETRY_LIMIT, type CycleView } from './verdict.ts';
/** 합성 종료 이벤트 id. 같은 Run 을 몇 번 처리해도 Ingest 가 하나로 받는다 */
export const abandonedEventId = (runId: string): string => `abandoned:${runId}`;

export interface SweepOptions {
  nowMs: number;
  /** lease 만료(또는 lease 가 없으면 마지막 이벤트) 뒤 이만큼 지나야 버려진 것으로 본다. 기본은 lease TTL 과 같은 60초: heartbeat 를 두 번 놓치고 TTL 까지 지난 뒤에도 한 번 더 기다려 네트워크 흔들림과 진짜 죽음을 가른다 */
  graceMs: number;
  newRunId?: () => string;
}

export interface SweepResult { abandoned: string[]; replacements: Array<{ runId: string; replaces: string; targetId: string }> }

/**
 * 버려진 Run 정리: 이벤트는 있는데 끝나지 않았고 lease 만료(없으면 마지막 이벤트 시각)로부터 유예가 지난 Run 을
 * 합성 `run.finished infra-failed` 로 닫고, Cycle 의 retryLimit 안이면 같은 타깃의 대체 Run 을 등록한다. 클레임·조회 때 불린다(별도 스케줄러 없음).
 */
/** 모든 Cycle 에 대해 sweepAbandoned. 클레임 직전에 불러 대체 Run 이 같은 클레임에서 잡히게 한다 */
export async function sweepAllAbandoned(events: EventStore, cycles: CycleStore, opts: SweepOptions): Promise<SweepResult> {
  const total: SweepResult = { abandoned: [], replacements: [] };
  for (const c of await cycles.listCycles()) {
    const r = await sweepAbandoned(events, cycles, c.cycleId, opts);
    total.abandoned.push(...r.abandoned); total.replacements.push(...r.replacements);
  }
  return total;
}

export async function sweepAbandoned(events: EventStore, cycles: CycleStore, cycleId: string, opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { abandoned: [], replacements: [] };
  const cycle = await cycles.getCycle(cycleId);
  if (!cycle) return result;
  const regs = await cycles.runsForCycle(cycleId);
  const limit = cycle.retryLimit ?? DEFAULT_RETRY_LIMIT;
  const usedFor = (targetId: string) => regs.filter((r) => r.targetId === targetId && r.replaces).length;

  for (const reg of regs) {
    if (reg.replacedBy) continue;
    const stored = await events.eventsForRun(reg.runId);
    if (stored.length === 0) continue; // 아직 시작도 안 한 Run 은 클레임 규칙(lease 만료 재클레임)이 다룬다
    const view = projectRun(stored);
    if (view.state === 'finished' || view.state === 'cancelled' || view.state === 'infra-failed') continue;
    const staleSince = reg.lease ? Date.parse(reg.lease.expiresAt) : Math.max(...stored.map((e) => Date.parse(e.at)));
    if (!(reg.lease ? leaseExpired(reg.lease, opts.nowMs) : true) || opts.nowMs - staleSince < opts.graceMs) continue;

    const abandonedAt = new Date(opts.nowMs).toISOString();
    await events.append({ schema: 1, eventId: abandonedEventId(reg.runId), runId: reg.runId, at: abandonedAt, type: 'run.finished', state: 'infra-failed' });
    result.abandoned.push(reg.runId);
    if (usedFor(reg.targetId) >= limit) continue; // 한도 소진: infra-failed 로 남아 Cycle 은 blocked
    const replacement: RunRegistration = { runId: (opts.newRunId ?? randomUUID)(), cycleId, targetId: reg.targetId, createdAt: abandonedAt, replaces: reg.runId };
    // 표시를 먼저 해야 두 호출자가 동시에 대체 Run 을 두 개 만들지 않는다(markReplaced 는 한 번만 성공)
    if ((await cycles.markReplaced(reg.runId, replacement.runId, abandonedAt)) !== 'marked') continue;
    await cycles.registerRun(replacement);
    regs.push(replacement);
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
    views.push(view);
  }
  return { ...computeCycle(cycle, regs, views), ...(warnings.length ? { warnings } : {}) };
}
