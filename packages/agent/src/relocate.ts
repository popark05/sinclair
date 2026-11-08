// 액션 전 안전망의 대상 재탐색: 모델이 고른 때의 대상 설명(descriptor)으로, 실행 직전 화면에서 같은 대상을 다시 찾는다.
// 결과: same(같은 ref 그대로) · moved(다른 ref 로 옮겨 감 — 목록 재렌더링 등) · gone(없음) · ambiguous(가릴 수 없는 후보 여럿).
import type { SemanticNode } from '@sinclair/protocol';

type Rect = NonNullable<SemanticNode['rect']>;
export interface TargetDescriptor {
  ref: string;
  role: string;
  /** 이름, 없으면 글자(정규화 전 원문) */
  label?: string;
  testId?: string;
  placeholder?: string;
  rect?: Rect;
  /** 가장 가까운 이름 있는 조상의 이름(목록 행처럼 같은 버튼이 되풀이될 때 어느 행인지) */
  parentLabel?: string;
}

export type Relocation =
  | { kind: 'same' | 'moved'; ref: string; score: number }
  | { kind: 'gone'; best?: { ref: string; score: number } }
  | { kind: 'ambiguous'; candidates: string[] };

/** 가중치: testId 는 앱이 붙인 식별자라 가장 강하고, 이름·글자가 그다음, 위치는 스크롤·재배치로 쉽게 바뀌어 보조, placeholder·부모 이름은 약한 보강 */
const W = { testId: 4, label: 3, rect: 2, placeholder: 1, parent: 1 } as const;
/** 이만큼 맞아야 같은 대상으로 본다: 이름이 정확히 같고 다른 신호 하나가 틀린 정도(예: 3/(3+1)=0.75)까지 허용 */
export const RELOCATE_THRESHOLD = 0.75;
/** 1등과 2등이 이보다 가까우면 애매함: 신호 하나(부모 이름, 가중 1/6≈0.17)라도 갈라 주면 넘는 폭 */
export const RELOCATE_MARGIN = 0.1;

const norm = (s: string | undefined): string | undefined => {
  const t = s?.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return t ? t : undefined;
};
const labelOf = (n: SemanticNode): string | undefined => n.name ?? n.text;
function similarity(a: string | undefined, b: string | undefined): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return x.includes(y) || y.includes(x) ? 0.6 : 0; // 글자 일부가 바뀜(개수 배지 "알림 3" → "알림 4" 등)
}
function iou(a: Rect, b: Rect | undefined): number {
  if (!b) return 0;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** 노드마다 가장 가까운 이름 있는 조상의 이름과 함께 훑는다 */
function* walk(node: SemanticNode, parentLabel?: string): Generator<{ node: SemanticNode; parentLabel: string | undefined }> {
  yield { node, parentLabel };
  const label = labelOf(node) ?? parentLabel;
  for (const c of node.children ?? []) yield* walk(c, label);
}

export function describeTarget(root: SemanticNode, ref: string): TargetDescriptor | undefined {
  for (const { node, parentLabel } of walk(root)) {
    if (node.ref !== ref) continue;
    const label = labelOf(node);
    return { ref, role: node.role, ...(label ? { label } : {}), ...(node.testId ? { testId: node.testId } : {}), ...(node.placeholder ? { placeholder: node.placeholder } : {}), ...(node.rect ? { rect: node.rect } : {}), ...(parentLabel ? { parentLabel } : {}) };
  }
  return undefined;
}

interface Scored { ref: string; identity: number; full: number }

function score(d: TargetDescriptor, node: SemanticNode, parentLabel: string | undefined): Scored {
  // 설명에 있는 신호만 센다(없는 신호로 모든 후보를 똑같이 깎지 않는다). 후보에 그 신호가 없으면 0점
  let idW = 0, idS = 0;
  const add = (w: number, s: number) => { idW += w; idS += w * s; };
  if (d.testId) add(W.testId, node.testId === d.testId ? 1 : 0);
  if (d.label) add(W.label, similarity(d.label, labelOf(node)));
  if (d.placeholder) add(W.placeholder, similarity(d.placeholder, node.placeholder));
  if (d.parentLabel) add(W.parent, similarity(d.parentLabel, parentLabel));
  const rW = d.rect ? W.rect : 0;
  const rS = d.rect ? iou(d.rect, node.rect) : 0;
  const identity = idW ? idS / idW : rW ? rS : 1;
  const full = idW + rW ? (idS + rW * rS) / (idW + rW) : 1;
  return { ref: node.ref, identity, full };
}

/**
 * 같은 역할의 노드만 후보(역할이 바뀌었으면 다른 대상이다). 고르는 순서: 정체 신호(testId·이름·placeholder·부모) 점수가 먼저, 위치를 더한 점수는 동점 가르기.
 * 위치를 정체와 같은 저울에 올리면 목록 행이 서로 자리를 바꿀 때 "같은 자리의 다른 행" 을 고른다(엉뚱한 행의 삭제 버튼).
 * 정체 신호가 하나도 없는 대상(이름 없는 입력 칸)은 위치만으로 찾는다.
 */
export function relocate(d: TargetDescriptor, root: SemanticNode): Relocation {
  const scored: Scored[] = [];
  for (const { node, parentLabel } of walk(root)) if (node.role === d.role) scored.push(score(d, node, parentLabel));
  scored.sort((a, b) => b.identity - a.identity || b.full - a.full);
  const top = scored[0];
  if (!top || top.identity < RELOCATE_THRESHOLD) return { kind: 'gone', ...(top ? { best: { ref: top.ref, score: top.identity } } : {}) };
  const contenders = scored.filter((s) => s.identity >= top.identity - RELOCATE_MARGIN && s !== top);
  const rival = contenders.sort((a, b) => b.full - a.full)[0];
  if (rival && top.full - rival.full < RELOCATE_MARGIN) {
    // 원래 ref 가 그대로 남아 있고 동점이면 그것을 믿는다(화면이 안 바뀐 경우)
    const same = [top, ...contenders].find((s) => s.ref === d.ref && Math.abs(s.full - top.full) < RELOCATE_MARGIN);
    if (same && same.full >= top.full) return { kind: 'same', ref: same.ref, score: same.full };
    return { kind: 'ambiguous', candidates: [top, ...contenders].filter((s) => top.full - s.full < RELOCATE_MARGIN).map((s) => s.ref) };
  }
  return { kind: top.ref === d.ref ? 'same' : 'moved', ref: top.ref, score: top.full };
}
