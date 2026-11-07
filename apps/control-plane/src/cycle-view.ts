// Cycle 조회 조립: 등록 레코드 + 각 run 의 이벤트 투영 → computeCycle. HTTP 와 (앞으로) Console 이 같은 뷰를 쓴다.
import type { CycleStore } from './cycle-store.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';
import { computeCycle, type CycleView } from './verdict.ts';

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
