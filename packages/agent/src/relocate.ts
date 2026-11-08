// 액션 전 안전망의 대상 재탐색: 모델이 고른 때의 대상 설명(TargetDescriptor — 녹화 캐시의 descriptor 와는 다른 것)으로, 실행 직전 화면에서 같은 대상을 다시 찾는다.
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
  /** 가장 가까운 이름 있는 조상의 이름 */
  parentLabel?: string;
  /** 같은 부모 아래 다른 노드들의 글자(Android 목록 행처럼 행 글자가 버튼의 형제일 때 어느 행인지 가른다) */
  context?: string[];
  /** 모델이 본 화면에서 이 설명으로 대상 하나를 가릴 수 있었는가. false 면 다른 노드로 옮겨 찾지 않는다(같은 ref·같은 자리만 믿는다) */
  distinct?: boolean;
}

export type Relocation =
  | { kind: 'same' | 'moved'; ref: string; score: number }
  | { kind: 'gone'; best?: { ref: string; score: number } }
  | { kind: 'ambiguous'; candidates: string[] };

/** 가중치: testId 는 앱이 붙인 식별자라 가장 강하고, 이름·글자가 그다음, 주변 글자(행 맥락)와 위치가 보조, placeholder·부모 이름은 약한 보강 */
const W = { testId: 4, label: 3, context: 2, rect: 2, placeholder: 1, parent: 1 } as const;
/** 이만큼 맞아야 같은 대상으로 본다: 이름이 같아도 행 맥락(가중 2)이 틀리면((3+1)/6≈0.67) 못 넘는다 — 다른 행의 같은 버튼으로 옮기지 않게 */
export const RELOCATE_THRESHOLD = 0.75;
/** 1등과 2등이 이보다 가까우면 애매함: 신호 하나(부모 이름, 가중 1/6≈0.17)라도 갈라 주면 넘는 폭 */
export const RELOCATE_MARGIN = 0.1;
/** distinct 가 아닌 대상을 같은 ref 로 믿는 위치 일치 하한 */
const SAME_PLACE_IOU = 0.9;
/** 맥락으로 쓰는 형제 글자 수 상한: 넘으면 부모가 목록 행이 아니라 화면 전체에 가까워 맥락이 다른 변화에 흔들린다 */
const MAX_CONTEXT = 8;

const norm = (s: string | undefined): string | undefined => {
  const t = s?.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return t ? t : undefined;
};
const labelOf = (n: SemanticNode): string | undefined => n.name ?? n.text;
/** 같음 1, 숫자만 다름 0.9(배지 "알림 3"→"알림 4", 카운트다운 "(59초)"→"(58초)"), 그 밖은 단어 겹침(Jaccard)×0.8 */
function similarity(a: string | undefined, b: string | undefined): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dx = x.replace(/\d+/g, '#'), dy = y.replace(/\d+/g, '#');
  if (dx === dy) return 0.9;
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  return (inter / (tx.size + ty.size - inter)) * 0.8;
}
const validRect = (r: Rect | undefined): r is Rect => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
/** 위치 일치: 겹침(IoU)과 중심 거리 중 큰 것. 중심 거리는 크기가 비슷할 때만(스크롤로 조금 밀린 같은 대상) */
function place(a: Rect, b: Rect | undefined): number {
  if (!validRect(b)) return 0;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const iou = inter / (a.width * a.height + b.width * b.height - inter);
  const sameSize = Math.min(a.width, b.width) / Math.max(a.width, b.width) >= 0.8 && Math.min(a.height, b.height) / Math.max(a.height, b.height) >= 0.8;
  const dist = Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
  const center = sameSize ? Math.max(0, 1 - dist / Math.max(a.width, a.height)) : 0;
  return Math.max(iou, center);
}

interface Visit { node: SemanticNode; parentLabel: string | undefined; context: string[] | undefined }
/** 노드마다 가장 가까운 이름 있는 조상의 이름과 형제 맥락과 함께 훑는다 */
function* walk(node: SemanticNode, parentLabel?: string, context?: string[], depth = 0): Generator<Visit> {
  yield { node, parentLabel, context };
  const label = labelOf(node) ?? parentLabel;
  const children = node.children ?? [];
  // 맥락: 부모 아래(자식들의 하위 트리)의 글자 중 자기 하위 트리 것을 뺀 것. 루트 바로 아래 노드는 맥락이 화면 전체라, 글자가 많은 부모는 목록 행이 아니라 쓰지 않는다
  const labels = depth > 0 ? children.flatMap((c) => collectLabels(c)) : [];
  for (const c of children) {
    const own = new Set(collectLabels(c));
    const ctx = labels.filter((l) => !own.has(l));
    yield* walk(c, label, ctx.length && labels.length <= MAX_CONTEXT ? ctx : undefined, depth + 1);
  }
}
function collectLabels(node: SemanticNode, out: string[] = []): string[] {
  const l = labelOf(node);
  if (l) out.push(l);
  for (const c of node.children ?? []) collectLabels(c, out);
  return out;
}
const walkRoot = (root: SemanticNode): Generator<Visit> => walk(root);

interface Scored { ref: string; identity: number; full: number; place: number; signals: boolean }

function score(d: TargetDescriptor, v: Visit): Scored {
  const { node } = v;
  // 설명에 있는 신호만 센다(없는 신호로 모든 후보를 똑같이 깎지 않는다). 후보에 그 신호가 없으면 0점
  let idW = 0, idS = 0;
  const add = (w: number, s: number) => { idW += w; idS += w * s; };
  if (d.testId) add(W.testId, node.testId === d.testId ? 1 : 0);
  if (d.label) add(W.label, similarity(d.label, labelOf(node)));
  if (d.placeholder) add(W.placeholder, similarity(d.placeholder, node.placeholder));
  if (d.parentLabel) add(W.parent, similarity(d.parentLabel, v.parentLabel));
  if (d.context?.length) {
    const have = v.context ?? [];
    add(W.context, d.context.filter((c) => have.some((h) => similarity(c, h) >= 0.9)).length / d.context.length);
  }
  const rect = validRect(d.rect) ? d.rect : undefined;
  const p = rect ? place(rect, node.rect) : 0;
  const rW = rect ? W.rect : 0;
  const identity = idW ? idS / idW : rW ? p : 1;
  const full = idW + rW ? (idS + rW * p) / (idW + rW) : 1;
  return { ref: node.ref, identity, full, place: p, signals: idW + rW > 0 };
}

export function describeTarget(root: SemanticNode, ref: string): TargetDescriptor | undefined {
  for (const v of walkRoot(root)) {
    if (v.node.ref !== ref) continue;
    const { node } = v;
    const label = labelOf(node);
    const d: TargetDescriptor = {
      ref, role: node.role, ...(label ? { label } : {}), ...(node.testId ? { testId: node.testId } : {}), ...(node.placeholder ? { placeholder: node.placeholder } : {}),
      ...(validRect(node.rect) ? { rect: node.rect } : {}), ...(v.parentLabel ? { parentLabel: v.parentLabel } : {}), ...(v.context ? { context: v.context.slice(0, MAX_CONTEXT) } : {}),
    };
    // 모델이 본 화면에서 이 설명이 대상 하나만 가리키는가: 다른 노드가 정체 점수로 동점이면, 실행 직전 화면에서 정체만으로 옮겨 찾는 것은 짐작이다
    const self = score(d, v);
    const rivals = [...walkRoot(root)].filter((o) => o.node.role === node.role && o.node.ref !== ref).map((o) => score(d, o));
    const distinct = !rivals.some((r) => r.identity >= self.identity - RELOCATE_MARGIN && Math.abs(r.full - self.full) < RELOCATE_MARGIN);
    return { ...d, distinct };
  }
  return undefined;
}

/**
 * 같은 역할의 노드만 후보(역할이 바뀌었으면 다른 대상이다). 고르는 순서: 정체 신호(testId·이름·맥락·placeholder·부모) 점수가 먼저, 위치를 더한 점수는 동점 가르기.
 * 위치를 정체와 같은 저울에 올리면 목록 행이 자리를 바꿀 때 "같은 자리의 다른 행" 을 고른다(엉뚱한 행의 삭제 버튼). 정체 신호가 없는 대상(이름 없는 아이콘)은 위치만으로 찾는다.
 */
export function relocate(d: TargetDescriptor, root: SemanticNode): Relocation {
  const scored: Scored[] = [];
  for (const v of walkRoot(root)) if (v.node.role === d.role) scored.push(score(d, v));
  scored.sort((a, b) => b.identity - a.identity || b.full - a.full);
  const top = scored[0];
  if (!top || top.identity < RELOCATE_THRESHOLD) return { kind: 'gone', ...(top ? { best: { ref: top.ref, score: top.identity } } : {}) };
  const original = scored.find((s) => s.ref === d.ref);
  // 모델이 본 화면에서도 가릴 수 없던 대상: 같은 ref 가 같은 자리에 있을 때만 믿고, 다른 노드로 옮기지 않는다
  if (d.distinct === false) {
    if (original && original.identity >= RELOCATE_THRESHOLD && (!validRect(d.rect) || original.place >= SAME_PLACE_IOU)) return { kind: 'same', ref: original.ref, score: original.full };
    return { kind: 'ambiguous', candidates: scored.filter((s) => s.identity >= top.identity - RELOCATE_MARGIN).slice(0, 5).map((s) => s.ref) };
  }
  const contenders = scored.filter((s) => s !== top && s.identity >= top.identity - RELOCATE_MARGIN).sort((a, b) => b.full - a.full);
  const rival = contenders[0];
  if (rival && top.full - rival.full < RELOCATE_MARGIN) {
    const tied = [top, ...contenders].filter((s) => top.full - s.full < RELOCATE_MARGIN);
    // 신호가 있는 설명이고 원래 ref 가 동점 안에 그대로 있으면 그것을 믿는다(화면이 안 바뀐 동명 버튼). 신호가 없으면 같은 ref 라도 짐작이다
    const same = top.signals ? tied.find((s) => s.ref === d.ref) : undefined;
    if (same) return { kind: 'same', ref: same.ref, score: same.full };
    return { kind: 'ambiguous', candidates: tied.slice(0, 5).map((s) => s.ref) };
  }
  return { kind: top.ref === d.ref ? 'same' : 'moved', ref: top.ref, score: top.full };
}
