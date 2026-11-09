// Ledger: 한 act 세션의 턴 기록을 영역으로 나눠 모델 요청을 토큰 예산 안에 담는다.
// 영역: 목표(항상 전체) · 오래된 턴 요약(8턴 묶음 — 묶음은 한 번 접히면 다시 바뀌지 않아 모델 요약을 캐시할 수 있다) · 최근 턴 전체 · 현재 관찰.
// 이전 관찰은 전체로 싣지 않고 턴마다의 화면 변화(screenChange)로만 남는다.
import type { SemanticNode } from '@sinclair/protocol';
import type { AgentTurn, StepRequest } from './executor.ts';

/** 기본 예산: user 메시지 8,000 토큰. 보통 화면 트리(2~4천)와 최근 턴·요약이 넉넉히 들고, 턴마다 입력 비용·지연이 세션 길이와 무관하게 묶인다(system·툴은 고정이라 따로) */
export const DEFAULT_LEDGER_BUDGET = 8000;
/** 최근 턴 전체로 싣는 수: 모델이 방금 한 일과 그 결과(오류 사유)를 그대로 보며 고치려면 몇 턴이면 충분하다 */
export const DEFAULT_RECENT_TURNS = 8;
/** 예산이 빠듯해도 이만큼은 최근 턴을 전체로 남긴다(바로 앞의 실패를 모르면 같은 실수를 되풀이한다) */
export const MIN_RECENT_TURNS = 3;
/** 접는 묶음 크기: 경계가 고정되어야 묶음 요약을 한 번만 만든다 */
export const LEDGER_BLOCK = 8;
const DETAIL_FULL = 300;
const DETAIL_SHORT = 80;
const INTERACTIVE = new Set(['button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'switch', 'radio', 'link', 'tab', 'menuitem', 'slider']);

/** 보수적 토큰 추정: UTF-8 바이트/3. 한글(3바이트)은 글자당 1, 영문은 3자당 1 — 실제 토크나이저보다 크게 잡아 예산을 넘지 않게 */
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 지난 턴 한 줄. type 의 글자는 가린다(비밀번호일 수 있다 — 모델이 쓴 값이라도 되돌려 보내지 않는다) */
export function renderTurn(turn: AgentTurn, index: number, detailCap = DETAIL_FULL): string {
  const c = turn.call;
  let what = '(툴 호출 없음)';
  if (c) {
    const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>;
    const parts = Object.entries(input).map(([k, v]) => (k === 'ref' ? String(v) : k === 'text' ? `text=<입력함 ${typeof v === 'string' ? v.length : 0}자>` : `${k}=${JSON.stringify(v)}`));
    what = [c.name, ...parts].join(' ');
  }
  const moved = turn.retargeted ? ` (안전망이 같은 대상을 ${turn.retargeted} 에서 다시 찾아 실행)` : '';
  const change = turn.change ? ` — 화면 변화: ${cut(turn.change, detailCap)}` : '';
  return `${index + 1}. ${what} → ${turn.result}${moved}${turn.detail ? `: ${cut(turn.detail, detailCap)}` : ''}${change}`;
}

/** 묶음의 결정적 요약: 툴별 결과 집계 + 마지막 오류 + 마지막 화면 변화 */
export function summarizeTurns(turns: readonly AgentTurn[], startIndex: number): string {
  const byTool = new Map<string, Map<string, number>>();
  for (const t of turns) {
    const name = t.call?.name ?? '(툴 없음)';
    const m = byTool.get(name) ?? new Map<string, number>();
    m.set(t.result, (m.get(t.result) ?? 0) + 1);
    byTool.set(name, m);
  }
  const tools = [...byTool].map(([name, m]) => `${name} ${[...m.values()].reduce((a, b) => a + b, 0)}(${[...m].map(([r, n]) => `${r} ${n}`).join(', ')})`).join(', ');
  const lastBadAt = turns.map((t, i) => (t.result !== 'ok' ? i : -1)).filter((i) => i >= 0).at(-1);
  const bad = lastBadAt !== undefined ? `; 마지막 오류: ${renderTurn(turns[lastBadAt]!, startIndex + lastBadAt, DETAIL_SHORT)}` : '';
  const lastChange = [...turns].reverse().find((t) => t.change)?.change;
  return `${tools}${bad}${lastChange ? `; 마지막 화면 변화: ${cut(lastChange, DETAIL_SHORT)}` : ''}`;
}

export interface LedgerOptions {
  budgetTokens?: number;
  recentTurns?: number;
  /** 접힌 묶음(턴 from–from+7, 1부터)의 모델 요약. 없으면(undefined) 결정적 요약 */
  blockSummary?: (from: number, turns: readonly AgentTurn[]) => string | undefined;
}
export interface LedgerResult { text: string; estimatedTokens: number; foldedTurns: number; recentTurns: number; truncatedObservation: boolean }

/** 관찰을 예산에 맞게 자른다: 누를 수 있는 노드를 먼저, 그다음 나머지를 문서 순서대로. 첫 줄(루트)은 늘 남긴다 */
function fitObservation(observation: string, budget: number): { text: string; truncated: boolean } {
  if (estimateTokens(observation) <= budget) return { text: observation, truncated: false };
  const lines = observation.split('\n');
  const keep = new Set<number>([0]);
  let used = estimateTokens(lines[0]!) + 20; // 생략 표시 몫
  const roleOf = (l: string) => l.trim().split(' ')[1] ?? '';
  const order = [...lines.keys()].slice(1).sort((a, b) => Number(INTERACTIVE.has(roleOf(lines[b]!))) - Number(INTERACTIVE.has(roleOf(lines[a]!))) || a - b);
  for (const i of order) {
    const cost = estimateTokens(lines[i]!) + 1;
    if (used + cost > budget) continue;
    keep.add(i); used += cost;
  }
  const kept = lines.filter((_, i) => keep.has(i));
  return { text: `${kept.join('\n')}\n… (${lines.length - kept.length}줄 생략: 화면이 예산보다 크다 — 누를 수 있는 노드를 먼저 남김)`, truncated: true };
}

export function renderLedger(req: StepRequest, opts: LedgerOptions = {}): LedgerResult {
  const budget = opts.budgetTokens ?? DEFAULT_LEDGER_BUDGET;
  const recentWanted = opts.recentTurns ?? DEFAULT_RECENT_TURNS;
  const h = req.history;
  const n = h.length;
  // 묶음 경계: 최근 recentWanted 턴을 뺀 나머지 중 묶음으로 꽉 찬 것만 접는다(최근 전체 턴은 recentWanted ~ recentWanted+7)
  const blockFold = n > recentWanted ? Math.floor((n - recentWanted) / LEDGER_BLOCK) * LEDGER_BLOCK : 0;

  const build = (fold: number, detailCap: number, observation: string): string => {
    const folded: string[] = [];
    for (let from = 0; from < fold; from += LEDGER_BLOCK) {
      const to = Math.min(fold, from + LEDGER_BLOCK);
      const turns = h.slice(from, to);
      const model = to - from === LEDGER_BLOCK && to <= blockFold ? opts.blockSummary?.(from + 1, turns) : undefined;
      folded.push(`턴 ${from + 1}–${to} 요약: ${model ?? summarizeTurns(turns, from)}`);
    }
    return [
      `목표: ${req.goal}`,
      ...(req.incident ? ['', `⚠ ${req.incident}`] : []),
      '',
      '지난 턴:',
      ...(n === 0 ? ['(없음)'] : [...folded, ...h.slice(fold).map((t, i) => renderTurn(t, fold + i, detailCap))]),
      '',
      '지금 화면:',
      observation,
      '',
      '다음 툴 하나를 불러라.',
    ].join('\n');
  };
  const done = (fold: number, detailCap: number, observation: string, truncated: boolean): LedgerResult => {
    const text = build(fold, detailCap, observation);
    return { text, estimatedTokens: estimateTokens(text), foldedTurns: fold, recentTurns: n - fold, truncatedObservation: truncated };
  };
  const fits = (fold: number, cap: number) => estimateTokens(build(fold, cap, req.observation)) <= budget;

  // ① 묶음으로 접은 상태 ② 사유 문구 자르기 ③ 최근 턴 줄이기(최소 3) ④ 관찰 자르기
  if (fits(blockFold, DETAIL_FULL)) return done(blockFold, DETAIL_FULL, req.observation, false);
  if (fits(blockFold, DETAIL_SHORT)) return done(blockFold, DETAIL_SHORT, req.observation, false);
  let fold = blockFold;
  const minFold = Math.max(blockFold, n - MIN_RECENT_TURNS);
  while (fold < minFold && !fits(fold, DETAIL_SHORT)) fold++;
  if (fits(fold, DETAIL_SHORT)) return done(fold, DETAIL_SHORT, req.observation, false);
  const rest = estimateTokens(build(fold, DETAIL_SHORT, ''));
  const obs = fitObservation(req.observation, Math.max(200, budget - rest));
  return done(fold, DETAIL_SHORT, obs.text, obs.truncated);
}

/** 화면 변화 한 줄: 나타난 글자·사라진 글자(각 5개까지, 나머지는 개수). 같으면 undefined */
export function screenChange(before: SemanticNode, after: SemanticNode): string | undefined {
  const labels = (root: SemanticNode): string[] => {
    const out: string[] = [];
    const walk = (x: SemanticNode) => { const l = x.name ?? x.text; if (l) out.push(l); for (const c of x.children ?? []) walk(c); };
    walk(root);
    return [...new Set(out)];
  };
  const a = labels(before), b = labels(after);
  const sa = new Set(a), sb = new Set(b);
  const added = b.filter((l) => !sa.has(l)), removed = a.filter((l) => !sb.has(l));
  if (!added.length && !removed.length) return undefined;
  const list = (xs: string[]) => `${xs.slice(0, 5).map((x) => JSON.stringify(cut(x, 30))).join(' ')}${xs.length > 5 ? ` 외 ${xs.length - 5}개` : ''}`;
  return [added.length ? `+ ${list(added)}` : '', removed.length ? `− ${list(removed)}` : ''].filter(Boolean).join(' / ');
}
