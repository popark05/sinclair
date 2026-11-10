// Console 이 보는 집계: Cycle 의 모델 사용량(05)과 테스트 안정성 이력(06). 저장된 이벤트의 투영에서 계산한다(저장하지 않는다).
import type { CaseVerdict } from '@sinclair/protocol';
import type { CycleStore } from './cycle-store.ts';
import { buildCycleView } from './cycle-view.ts';
import { projectRun } from './projection.ts';
import type { EventStore } from './store.ts';

export interface UsageTotals {
  modelCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  /** 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기). 입력 토큰이 하나도 없으면 null */
  cacheHitRate: number | null;
}
export interface CycleUsage { cycleId: string; total: UsageTotals; byTarget: Record<string, UsageTotals>; byTest: Record<string, UsageTotals> }

type Sum = Omit<UsageTotals, 'cacheHitRate'>;
const zero = (): Sum => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const finish = (s: Sum): UsageTotals => {
  const denom = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  return { ...s, cacheHitRate: denom > 0 ? s.cacheReadTokens / denom : null };
};

/** 대체된(버려진) Run 까지 센다: 판정에서는 빠져도 그 모델 호출의 비용은 이미 들었다 */
export async function cycleUsage(events: EventStore, cycles: CycleStore, cycleId: string): Promise<CycleUsage | undefined> {
  if (!(await cycles.getCycle(cycleId))) return undefined;
  const total = zero();
  const byTarget = new Map<string, Sum>();
  const byTest = new Map<string, Sum>();
  for (const reg of await cycles.runsForCycle(cycleId)) {
    const view = projectRun(await events.eventsForRun(reg.runId));
    const target = byTarget.get(reg.targetId) ?? zero();
    byTarget.set(reg.targetId, target);
    for (const a of view.attempts) {
      const test = a.testId ? byTest.get(a.testId) ?? zero() : undefined;
      if (a.testId && test) byTest.set(a.testId, test);
      for (const s of a.steps) for (const acc of [total, target, ...(test ? [test] : [])]) {
        acc.modelCalls += s.modelCalls;
        acc.inputTokens += s.usage?.inputTokens ?? 0;
        acc.outputTokens += s.usage?.outputTokens ?? 0;
        acc.cacheReadTokens += s.usage?.cacheReadTokens ?? 0;
        acc.cacheWriteTokens += s.usage?.cacheWriteTokens ?? 0;
      }
    }
  }
  const map = (m: Map<string, Sum>) => Object.fromEntries([...m].map(([k, v]) => [k, finish(v)]));
  return { cycleId, total: finish(total), byTarget: map(byTarget), byTest: map(byTest) };
}

export interface HistoryCell { cycleId: string; build: string; createdAt: string; targetId: string; verdict: CaseVerdict }
export interface TestHistory {
  testId: string;
  /** 오래된 Cycle → 최신, 같은 Cycle 안에서는 Cycle 의 타깃 순 */
  cells: HistoryCell[];
  stats: Record<CaseVerdict, number>;
  /** 흔들림(passed-flaky) / (통과 + 흔들림 + 실패). 그런 셀이 없으면 null */
  flakyRate: number | null;
}
export interface HistoryView { cycles: Array<{ cycleId: string; build: string; createdAt: string }>; tests: TestHistory[] }

/** 최근 limit 개 Cycle(최신 기준)의 매트릭스를 테스트별로 모은다. flaky 비율 높은 순(같으면 실패 많은 순, 이름 순) */
export async function testHistory(events: EventStore, cycles: CycleStore, opts: { limit: number; testId?: string }): Promise<HistoryView> {
  const recent = (await cycles.listCycles()).map((c, i) => ({ c, i })).sort((a, b) => b.c.createdAt.localeCompare(a.c.createdAt) || b.i - a.i).slice(0, opts.limit).reverse().map((x) => x.c);
  const tests = new Map<string, HistoryCell[]>();
  for (const c of recent) {
    const view = await buildCycleView(events, cycles, c.cycleId);
    if (!view) continue;
    for (const [testId, row] of Object.entries(view.matrix)) {
      if (opts.testId !== undefined && testId !== opts.testId) continue;
      const cells = tests.get(testId) ?? [];
      tests.set(testId, cells);
      for (const targetId of view.targets) { const cell = row[targetId]; if (cell) cells.push({ cycleId: c.cycleId, build: c.build, createdAt: c.createdAt, targetId, verdict: cell.verdict }); }
    }
  }
  const out: TestHistory[] = [...tests].map(([testId, cells]) => {
    const stats: Record<CaseVerdict, number> = { passed: 0, 'passed-flaky': 0, failed: 0, blocked: 0, skipped: 0, waived: 0 };
    for (const c of cells) stats[c.verdict]++;
    const denom = stats.passed + stats['passed-flaky'] + stats.failed;
    return { testId, cells, stats, flakyRate: denom ? stats['passed-flaky'] / denom : null };
  });
  out.sort((a, b) => (b.flakyRate ?? -1) - (a.flakyRate ?? -1) || b.stats.failed - a.stats.failed || a.testId.localeCompare(b.testId));
  return { cycles: recent.map((c) => ({ cycleId: c.cycleId, build: c.build, createdAt: c.createdAt })), tests: out };
}
