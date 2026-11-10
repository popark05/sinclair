// Issue: 실패를 원인별로 묶는다. 자동 묶음은 서명(errorCode + 정규화한 실패 스텝 지시)으로, 분류(제품·테스트·인프라·불안정)·메모·티켓은 사람이 단다.
// 발생 목록은 최근 Cycle 들의 이벤트에서 그때그때 계산하고(저장하지 않는다), 저장하는 것은 사람의 분류뿐이다.
import { createHash } from 'node:crypto';
import type { CycleStore } from './cycle-store.ts';
import { projectRun } from './projection.ts';
import type { EventStore } from './store.ts';

export const ISSUE_CATEGORIES = ['product', 'test', 'infra', 'flaky'] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export interface IssueTriage { category?: IssueCategory; note?: string; ticketUrl?: string; updatedAt?: string }
export interface IssueStore {
  get(id: string): Promise<IssueTriage | undefined>;
  set(id: string, triage: IssueTriage): Promise<void>;
}
export const ISSUE_ID = /^[0-9a-f]{12}$/;
/** 기기·설정 문제라 테스트·제품 탓이 아닌 errorCode: 추천 분류 infra */
const INFRA_CODES = new Set(['device-unavailable', 'agent-config', 'secret-missing', 'engine-closed', 'cancelled']);

export interface IssueOccurrence { cycleId: string; build: string; testId: string; targetId: string; runId: string; attemptId: string; at?: string }
export interface IssueView extends IssueTriage {
  id: string; errorCode: string; summary: string; count: number; tests: string[];
  /** 규칙으로 고른 추천 분류(사람이 정한 category 가 우선) */
  suggested?: IssueCategory;
  /** 최신 먼저 */
  occurrences: IssueOccurrence[];
}

/**
 * 서명: 같은 원인이면 같은 값. 실패 지시에서 바뀌는 것(기다린 시간·ref·숫자·마지막 화면 요약)을 빼고 errorCode 와 합친다.
 * 그래서 다른 테스트가 같은 대상에서 같은 식으로 실패하면 한 Issue 다(같은 버튼이 사라짐).
 */
export function issueSignature(errorCode: string, instruction = ''): { id: string; summary: string } {
  let s = instruction.replace(/\s*\(\d+ms 기다림\)/g, '');
  s = s.split(/\.?\s*마지막 (?:화면|관찰)/)[0] ?? s;
  s = s.replace(/@[\w:.-]+/g, '@ref').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { id: createHash('sha1').update(`${errorCode}\u0000${s}`).digest('hex').slice(0, 12), summary: s };
}

export async function listIssues(events: EventStore, cycles: CycleStore, issues: IssueStore, opts: { limit: number }): Promise<IssueView[]> {
  const recent = (await cycles.listCycles()).map((c, i) => ({ c, i })).sort((a, b) => b.c.createdAt.localeCompare(a.c.createdAt) || b.i - a.i).slice(0, opts.limit).map((x) => x.c);
  const groups = new Map<string, { errorCode: string; summary: string; occurrences: IssueOccurrence[] }>();
  for (const c of recent) {
    for (const reg of await cycles.runsForCycle(c.cycleId)) {
      const view = projectRun(await events.eventsForRun(reg.runId));
      for (const a of view.attempts) {
        if ((a.result !== 'failed' && a.result !== 'blocked') || !a.testId) continue;
        const errorCode = a.errorCode ?? 'error';
        const failedStep = [...a.steps].reverse().find((s) => s.instruction?.includes('→ 실패')) ?? a.steps.at(-1);
        const sig = issueSignature(errorCode, failedStep?.instruction);
        const g = groups.get(sig.id) ?? { errorCode, summary: sig.summary, occurrences: [] };
        groups.set(sig.id, g);
        g.occurrences.push({ cycleId: c.cycleId, build: c.build, testId: a.testId, targetId: reg.targetId, runId: reg.runId, attemptId: a.attemptId, ...(a.finishedAt ?? a.startedAt ? { at: a.finishedAt ?? a.startedAt } : {}) });
      }
    }
  }
  const out: IssueView[] = [];
  for (const [id, g] of groups) {
    const triage = (await issues.get(id)) ?? {};
    g.occurrences.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    out.push({
      id, errorCode: g.errorCode, summary: g.summary, count: g.occurrences.length, tests: [...new Set(g.occurrences.map((o) => o.testId))].sort((a, b) => a.localeCompare(b)),
      ...(INFRA_CODES.has(g.errorCode) ? { suggested: 'infra' as const } : {}), ...triage, occurrences: g.occurrences,
    });
  }
  // 많이 난 것 먼저, 같으면 최근 것
  return out.sort((a, b) => b.count - a.count || (b.occurrences[0]?.at ?? '').localeCompare(a.occurrences[0]?.at ?? ''));
}

/** 분류 입력 검사: category(목록 또는 null = 지움)·note(2000자)·ticketUrl(http/https). 오류 사유 또는 정리된 값 */
export function parseTriage(body: unknown): { ok: true; patch: { category?: IssueCategory | null; note?: string; ticketUrl?: string } } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '객체여야 함' };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['category', 'note', 'ticketUrl'].includes(k)) return { ok: false, error: `모르는 키: ${k}` };
  if (b.category !== undefined && b.category !== null && !(ISSUE_CATEGORIES as readonly unknown[]).includes(b.category)) return { ok: false, error: `category 는 ${ISSUE_CATEGORIES.join('|')} 또는 null` };
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 2000)) return { ok: false, error: 'note 는 2000자 이하 문자열' };
  if (b.ticketUrl !== undefined && (typeof b.ticketUrl !== 'string' || b.ticketUrl.length > 500 || !/^https?:\/\/[^\s]+$/.test(b.ticketUrl))) return { ok: false, error: 'ticketUrl 은 http(s) 주소' };
  return { ok: true, patch: b as { category?: IssueCategory | null; note?: string; ticketUrl?: string } };
}

export function createMemoryIssueStore(): IssueStore {
  const m = new Map<string, IssueTriage>();
  return { async get(id) { return m.get(id); }, async set(id, t) { m.set(id, t); } };
}
