// Verdict 계산: Cycle 의 run 투영들에서 TestCase × 타깃 매트릭스와 Cycle 판정을 만든다. 순수 함수.
// 규칙(specs/0001 "Verdict 규칙"): 케이스의 최종 상태는 마지막(attemptNo 최대, 끝난) Attempt. 재시도로 통과하면 passed-flaky.
// 필수 케이스(requiredTags 가 비면 전부, 아니면 그 태그를 가진 테스트)가 전부 passed/passed-flaky 면 verified, 아니면 blocked.
// 끝나지 않은 run 이 있으면 incomplete. `waived` 는 Issue/waive 티켓이 만들기 전까지 생성 경로가 없고(통과로 집계), Cycle 상태(CYCLE_STATES)의 expired/cancelled 는
// Scheduler 가 생기기 전까지 도달하지 않는다(Run 상태 cancelled 는 러너 취소 신호가 만든다). 판정은 저장하지 않고 조회마다 다시 계산한다(늦게 온 이벤트가 반영된다).
import type { CaseVerdict, CycleState, CycleVerdict, RunState } from '@sinclair/protocol';
import type { CycleRecord, RunLease, RunRegistration, SuiteFilter } from './cycle-store.ts';
import type { AttemptView, RunView } from './projection.ts';

/** 버려진 Run 의 기본 대체 한도. 한 번은 인프라 흔들림으로 보고, 두 번째도 버려지면 사람이 본다 */
export const DEFAULT_RETRY_LIMIT = 1;
export const MAX_RETRY_LIMIT = 5;
/** 러너 CANCELLED_CODE 와 같은 문자열(apps 는 러너를 import 하지 않는다; runner-agent 테스트가 같음을 확인) */
export const CANCELLED_CODE = 'cancelled';

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
  /** 등록 순서. 이벤트가 아직 없는 run 은 queued. lease 는 에이전트가 잡은 표시. replacedBy 가 있는 run 은 버려져 대체된 것으로, 행에는 남지만 판정에서는 빠진다 */
  runs: Array<{ runId: string; targetId: string; state: RunState; lease?: RunLease; replaces?: string; replacedBy?: string; abandonedAt?: string }>;
  /** 버려진 Run 을 대체할 수 있는 횟수(타깃별). 생성 시 정한다 */
  retryLimit: number;
  /** 지금까지 만든 대체 Run 수(타깃별) */
  retriesUsed: Record<string, number>;
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
  const all = registrations.filter((r) => r.cycleId === cycle.cycleId).map((r) => ({ reg: r, view: byId.get(r.runId) }));
  const runRows = all.map(({ reg, view }) => ({
    runId: reg.runId, targetId: reg.targetId, state: view?.state ?? ('queued' as RunState), ...(reg.lease ? { lease: reg.lease } : {}),
    ...(reg.replaces ? { replaces: reg.replaces } : {}), ...(reg.replacedBy ? { replacedBy: reg.replacedBy } : {}), ...(reg.abandonedAt ? { abandonedAt: reg.abandonedAt } : {}),
  }));
  // 대체된(버려진) run 은 매트릭스·판정에서 뺀다: 그 몫은 대체 Run 이 한다. 행에는 이력으로 남긴다
  const runs = all.filter(({ reg }) => !reg.replacedBy);
  const live = runRows.filter((r) => !r.replacedBy);
  const retriesUsed: Record<string, number> = Object.fromEntries(cycle.targets.map((t) => [t, all.filter(({ reg }) => reg.targetId === t && reg.replaces).length]));

  const state: CycleState = runs.length === 0 ? 'draft' : live.every((r) => TERMINAL.has(r.state)) ? 'finished' : 'running';

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
        // 러너가 취소로 시작하지 못한 케이스(errorCode cancelled 인 skipped)는 "안 돌기로 한 것" 이 아니라 "돌지 못한 것" 이라 blocked. 작성자의 test.skip 은 그대로 skipped
        if (cell) row[targetId] = cell.verdict === 'skipped' && lastFinished(attempts)?.errorCode === CANCELLED_CODE ? { ...cell, verdict: 'blocked' } : cell;
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
    const allRunsFinished = live.every((r) => r.state === 'finished');
    const ok = allRunsFinished && required.every((t) => cycle.targets.every((target) => {
      const v = matrix[t]?.[target]?.verdict;
      return v === 'passed' || v === 'passed-flaky' || v === 'waived';
    }));
    verdict = ok ? 'verified' : 'blocked';
  }

  return { cycleId: cycle.cycleId, build: cycle.build, targets: cycle.targets, requiredTags: cycle.requiredTags, ...(cycle.suite ? { suite: cycle.suite } : {}), createdAt: cycle.createdAt, state, verdict, runs: runRows, retryLimit: cycle.retryLimit ?? DEFAULT_RETRY_LIMIT, retriesUsed, required, matrix };
}
