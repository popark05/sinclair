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
/** Incident 알림 상한(글자) */
const INCIDENT_CAP = 300;
/** 목표가 예산의 이만큼을 넘으면 앞부분만 남긴다(목표는 잃지 않되, 터무니없이 긴 목표가 나머지 영역을 다 먹지 않게) */
const GOAL_SHARE = 0.25;
/** 요약 영역이 커지면(긴 세션) 최근 묶음 이만큼만 따로 두고 그 앞은 집계 한 줄로 합친다 */
const KEEP_BLOCKS = 2;
const omitted = (n: number): string => `… (${n}줄 생략: 화면이 예산보다 크다 — 누를 수 있는 노드를 먼저 남김)`;
const EDITABLE = new Set(['textbox', 'searchbox', 'combobox']);
const INTERACTIVE = new Set(['button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'switch', 'radio', 'link', 'tab', 'menuitem', 'slider']);

/** 보수적 토큰 추정: 비ASCII(한글 등)는 글자당 1.35, ASCII 글자는 2.5자당 1, 숫자·기호·공백은 1.8자당 1(트리 문법 @e123·id·따옴표는 잘게 쪼개진다), 전체에 10% 여유.
 *  2026-11-09 countTokens 실측: 한글 문장 860자 987 토큰(추정 1008+), 화면 트리 2590자 1498 토큰(추정 1545) — 둘 다 실제 이상.
 *  실제 토크나이저보다 크게 잡아 예산을 넘지 않게(opt-in 실호출이 countTokens 와 비교한다) */
export function estimateTokens(text: string): number {
  let letters = 0, others = 0, wide = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // 한글은 실제로 글자당 약 1.15 토큰(860자 문장 → countTokens 987, 2026-11-09 실측) — 3바이트당 1 로는 모자라 글자당 1.35 로 센다
    if (c > 0x7f) wide += Math.max(1.35, Buffer.byteLength(ch, 'utf8') / 3);
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) letters++;
    else others++;
  }
  return Math.ceil((wide + letters / 2.5 + others / 1.8) * 1.1);
}

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

/** 묶음 경계: 최근 recent 턴을 뺀 나머지 중 꽉 찬 묶음만 접는다(실행기의 모델 요약도 이 경계를 쓴다) */
export const blockFoldOf = (n: number, recent = DEFAULT_RECENT_TURNS): number => (n > recent ? Math.floor((n - recent) / LEDGER_BLOCK) * LEDGER_BLOCK : 0);

/** 글자를 토큰 예산에 맞게 앞에서부터 자른다 */
function cutToTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (estimateTokens(text.slice(0, mid)) <= tokens) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo);
}

/** 관찰을 예산에 맞게 자른다: 누를 수 있는 노드를 먼저, 그다음 나머지를 문서 순서대로. 첫 줄(루트)은 늘 남긴다 */
function fitObservation(observation: string, budget: number): { text: string; truncated: boolean } {
  if (estimateTokens(observation) <= budget) return { text: observation, truncated: false };
  const lines = observation.split('\n');
  // 생략 표시 몫은 그 문구 자체로(줄 수 자리까지) 센다 — 고정값은 추정 규칙이 바뀌면 어긋난다
  const room = budget - estimateTokens(omitted(lines.length)) - 2;
  if (room <= 0) return { text: '(화면 생략: 예산 부족)', truncated: true };
  const keep = new Map<number, string>();
  let used = 0;
  const roleOf = (l: string) => l.trim().split(' ')[1] ?? '';
  // 루트(첫 줄)부터, 그다음 누를 수 있는 노드, 나머지는 문서 순서. 한 줄이 남은 예산보다 길면 잘라서라도 넣는다(루트 한 줄이 거대한 화면)
  const order = [0, ...[...lines.keys()].slice(1).sort((a, b) => Number(INTERACTIVE.has(roleOf(lines[b]!))) - Number(INTERACTIVE.has(roleOf(lines[a]!))) || a - b)];
  for (const i of order) {
    const left = room - used;
    if (left <= 2) break;
    const line = estimateTokens(lines[i]!) + 1 <= left ? lines[i]! : i === 0 ? `${cutToTokens(lines[i]!, left - 2)}…` : undefined;
    if (line === undefined) continue;
    keep.set(i, line); used += estimateTokens(line) + 1;
  }
  const kept = [...keep].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  return { text: `${kept.join('\n')}\n${omitted(lines.length - kept.length)}`, truncated: true };
}

export function renderLedger(req: StepRequest, opts: LedgerOptions = {}): LedgerResult {
  const budget = opts.budgetTokens ?? DEFAULT_LEDGER_BUDGET;
  const h = req.history;
  const n = h.length;
  const blockFold = blockFoldOf(n, opts.recentTurns ?? DEFAULT_RECENT_TURNS);
  // 목표는 늘 싣되, 예산의 GOAL_SHARE 를 넘으면 앞부분만(잘렸다고 표시). Incident 알림도 상한
  const goalRoom = Math.floor(budget * GOAL_SHARE);
  const goalText = estimateTokens(req.goal) <= goalRoom ? req.goal : `${cutToTokens(req.goal, goalRoom - 15)}… (목표 ${req.goal.length - cutToTokens(req.goal, goalRoom - 15).length}자 생략)`;
  const incident = req.incident ? cut(req.incident.replace(/\s+/g, ' '), INCIDENT_CAP) : undefined;

  const build = (fold: number, detailCap: number, observation: string, keepBlocks = Infinity): string => {
    const folded: string[] = [];
    const blocks: Array<[number, number]> = [];
    for (let from = 0; from < fold; from += LEDGER_BLOCK) blocks.push([from, Math.min(fold, from + LEDGER_BLOCK)]);
    // ⑤ 긴 세션: 앞쪽 묶음들은 집계 한 줄로 합친다
    const merged = blocks.length > keepBlocks ? blocks.length - keepBlocks : 0;
    if (merged) { const to = blocks[merged - 1]![1]; folded.push(`턴 1–${to} 요약: ${summarizeTurns(h.slice(0, to), 0)}`); }
    for (const [from, to] of blocks.slice(merged)) {
      const turns = h.slice(from, to);
      const model = to - from === LEDGER_BLOCK && to <= blockFold ? opts.blockSummary?.(from + 1, turns) : undefined;
      // 모델 요약은 화면 글자에서 나온 것이라 지시로 읽지 않게 표시하고 한 줄로
      folded.push(`턴 ${from + 1}–${to} 요약${model ? '(요약 모델, 참고용)' : ''}: ${model ? cut(model.replace(/\s+/g, ' '), 400) : summarizeTurns(turns, from)}`);
    }
    return [
      `목표: ${goalText}`,
      ...(incident ? ['', `⚠ ${incident}`] : []),
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
  const done = (fold: number, detailCap: number, observation: string, truncated: boolean, keepBlocks = Infinity): LedgerResult => {
    const text = build(fold, detailCap, observation, keepBlocks);
    return { text, estimatedTokens: estimateTokens(text), foldedTurns: fold, recentTurns: n - fold, truncatedObservation: truncated };
  };
  const fits = (fold: number, cap: number, keepBlocks = Infinity) => estimateTokens(build(fold, cap, req.observation, keepBlocks)) <= budget;

  // ① 묶음으로 접은 상태 ② 사유 문구 자르기 ③ 최근 턴 줄이기(최소 3) ⑤ 앞쪽 묶음 합치기 ④ 관찰 자르기
  if (fits(blockFold, DETAIL_FULL)) return done(blockFold, DETAIL_FULL, req.observation, false);
  if (fits(blockFold, DETAIL_SHORT)) return done(blockFold, DETAIL_SHORT, req.observation, false);
  let fold = blockFold;
  const minFold = Math.max(blockFold, n - MIN_RECENT_TURNS);
  while (fold < minFold && !fits(fold, DETAIL_SHORT)) fold++;
  if (fits(fold, DETAIL_SHORT)) return done(fold, DETAIL_SHORT, req.observation, false);
  if (fits(fold, DETAIL_SHORT, KEEP_BLOCKS)) return done(fold, DETAIL_SHORT, req.observation, false, KEEP_BLOCKS);
  const keep = fits(fold, DETAIL_SHORT, 0) || estimateTokens(build(fold, DETAIL_SHORT, '', 0)) < estimateTokens(build(fold, DETAIL_SHORT, '', KEEP_BLOCKS)) ? 0 : KEEP_BLOCKS;
  const rest = estimateTokens(build(fold, DETAIL_SHORT, '', keep));
  const obs = fitObservation(req.observation, budget - rest);
  return done(fold, DETAIL_SHORT, obs.text, obs.truncated, keep);
}

/** 화면 변화 한 줄: 나타난·사라진 이름·글자(각 5개까지)와 스위치·체크 상태 변화. 같으면 undefined.
 *  숫자만 바뀌는 글자(시계·배터리·카운트다운)는 변화로 치지 않고, 입력 칸의 글자(입력한 값)는 내보내지 않는다 */
export function screenChange(before: SemanticNode, after: SemanticNode): string | undefined {
  const norm = (l: string) => l.replace(/\d+/g, '#');
  const collect = (root: SemanticNode) => {
    const labels = new Map<string, string>();
    const states = new Map<string, { label: string; checked: boolean }>();
    const walk = (x: SemanticNode) => {
      const l = EDITABLE.has(x.role) ? x.name : x.name ?? x.text;
      if (l) {
        labels.set(norm(l), l);
        if (x.states && 'checked' in x.states) states.set(`${x.role}|${norm(l)}`, { label: l, checked: x.states.checked === true });
      }
      for (const c of x.children ?? []) walk(c);
    };
    walk(root);
    return { labels, states };
  };
  const a = collect(before), b = collect(after);
  const added = [...b.labels].filter(([k]) => !a.labels.has(k)).map(([, l]) => l);
  const removed = [...a.labels].filter(([k]) => !b.labels.has(k)).map(([, l]) => l);
  const toggled = [...b.states].filter(([k, v]) => a.states.has(k) && a.states.get(k)!.checked !== v.checked).map(([, v]) => `~ ${JSON.stringify(cut(v.label, 30))} ${v.checked ? '선택됨' : '선택 해제'}`);
  if (!added.length && !removed.length && !toggled.length) return undefined;
  const list = (xs: string[]) => `${xs.slice(0, 5).map((x) => JSON.stringify(cut(x, 30))).join(' ')}${xs.length > 5 ? ` 외 ${xs.length - 5}개` : ''}`;
  return [added.length ? `+ ${list(added)}` : '', removed.length ? `− ${list(removed)}` : '', ...toggled.slice(0, 5)].filter(Boolean).join(' / ');
}
