// Verdict 계산: Cycle 의 run 투영들에서 TestCase × 타깃 매트릭스와 Cycle 판정을 만든다. 순수 함수.
// 규칙(specs/0001 "Verdict 규칙"): 케이스의 최종 상태는 마지막(attemptNo 최대, 끝난) Attempt. 재시도로 통과하면 passed-flaky.
// 필수 케이스(requiredTags 가 비면 전부, 아니면 그 태그를 가진 테스트)가 전부 passed/passed-flaky 면 verified, 아니면 blocked.
// 끝나지 않은 run 이 있으면 incomplete. `waived` 는 Issue/waive 티켓이 만들기 전까지 생성 경로가 없고(통과로 집계), CYCLE_STATES 의 expired/cancelled 는
// Scheduler 가 생기기 전까지 도달하지 않는다. 판정은 저장하지 않고 조회마다 다시 계산한다(늦게 온 이벤트가 반영된다).
import type { CaseVerdict, CycleState, CycleVerdict, RunState } from '@sinclair/protocol';
import type { CycleRecord, RunLease, RunRegistration, SuiteFilter } from './cycle-store.ts';
import type { AttemptView, RunView } from './projection.ts';

export interface CaseCell { verdict: CaseVerdict; attemptId?: string }

export interface CycleView {
  cycleId: string;
  build: string;
  targets: string[];
  requiredTags: string[];
  suite?: SuiteFilter;
  createdAt: string;
  state: CycleState;
  verdict: CycleVerdict;
  /** 등록 순서. 이벤트가 아직 없는 run 은 queued. lease 는 에이전트가 잡은 표시 */
  runs: Array<{ runId: string; targetId: string; state: RunState; lease?: RunLease }>;
  /** verified 판정에 들어가는 testId 들 */
  required: string[];
  /** testId → targetId → 셀. testId 는 처음 본 순서, targetId 는 Cycle 의 targets 순 */
  matrix: Record<string, Record<string, CaseCell>>;
}

/** 테스트 이름의 `@token` 들이 태그다(e2e/Playwright 관례). TestCase 레지스트리가 생기면 그쪽으로 옮긴다 */
export function tagsOf(testId: string): string[] {
  return [...testId.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1]!);
}

const TERMINAL: ReadonlySet<RunState> = new Set(['finished', 'cancelled', 'infra-failed']);

/** 끝난 attempt 중 attemptNo 가 가장 큰 것 */
function lastFinished(attempts: AttemptView[]): AttemptView | undefined {
  return attempts.filter((a) => a.result !== undefined).sort((x, y) => (y.attemptNo ?? 0) - (x.attemptNo ?? 0))[0];
}

function caseVerdict(attempts: AttemptView[]): CaseCell | undefined {
  const last = lastFinished(attempts);
  if (!last) return undefined;
  const cell: CaseCell = { verdict: last.result!, attemptId: last.attemptId };
  if (last.result === 'passed' && attempts.some((a) => a !== last && a.result === 'failed')) cell.verdict = 'passed-flaky';
  return cell;
}

export function computeCycle(cycle: CycleRecord, registrations: RunRegistration[], views: RunView[]): CycleView {
  const byId = new Map(views.map((v) => [v.runId, v]));
  const runs = registrations.filter((r) => r.cycleId === cycle.cycleId).map((r) => ({ reg: r, view: byId.get(r.runId) }));
  const runRows = runs.map(({ reg, view }) => ({ runId: reg.runId, targetId: reg.targetId, state: view?.state ?? ('queued' as RunState), ...(reg.lease ? { lease: reg.lease } : {}) }));

  const state: CycleState = runs.length === 0 ? 'draft' : runRows.every((r) => TERMINAL.has(r.state)) ? 'finished' : 'running';

  // 케이스 집합: 이 Cycle 의 run 들이 본 testId 합집합(처음 본 순서)
  const testIds: string[] = [];
  for (const { view } of runs) for (const a of view?.attempts ?? []) if (a.testId && !testIds.includes(a.testId)) testIds.push(a.testId);

  const matrix: CycleView['matrix'] = {};
  for (const testId of testIds) {
    const row: Record<string, CaseCell> = {};
    for (const targetId of cycle.targets) {
      // 같은 타깃에 run 이 여럿이면 뒤에 등록된 run 이 앞의 결과를 덮는다(재실행)
      for (const { reg, view } of runs) {
        if (reg.targetId !== targetId) continue;
        const attempts = (view?.attempts ?? []).filter((a) => a.testId === testId);
        const cell = caseVerdict(attempts);
        if (cell) row[targetId] = cell;
        else if (view && view.state === 'finished' && !row[targetId]) row[targetId] = { verdict: 'skipped' };
        else if (view && (view.state === 'infra-failed' || view.state === 'cancelled') && !row[targetId]) row[targetId] = { verdict: 'blocked' };
      }
    }
    matrix[testId] = row;
  }

  const required = testIds.filter((t) => cycle.requiredTags.length === 0 || tagsOf(t).some((tag) => cycle.requiredTags.includes(tag)));
  let verdict: CycleVerdict;
  if (state !== 'finished') verdict = 'incomplete';
  else {
    // infra-failed/cancelled 로 끝난 run 이 있으면 돌지 못한 케이스가 있을 수 있으므로(케이스 집합을 모르더라도) verified 가 아니다
    const allRunsFinished = runRows.every((r) => r.state === 'finished');
    const ok = allRunsFinished && required.every((t) => cycle.targets.every((target) => {
      const v = matrix[t]?.[target]?.verdict;
      return v === 'passed' || v === 'passed-flaky' || v === 'waived';
    }));
    verdict = ok ? 'verified' : 'blocked';
  }

  return { cycleId: cycle.cycleId, build: cycle.build, targets: cycle.targets, requiredTags: cycle.requiredTags, ...(cycle.suite ? { suite: cycle.suite } : {}), createdAt: cycle.createdAt, state, verdict, runs: runRows, required, matrix };
}
