// 화면 트리 노드 → locator 후보·속성(studio 04, 06): Inspector(렌더러)와 세션 턴의 결정적 locator(작업 프로세스)가 같은 규칙을 쓴다.
// 매치 수는 엔진과 같은 규칙(protocol locateInTree)으로 센다 — Inspector 가 1 이라고 하면 테스트에서도 하나로 정해진다.
import { locateInTree, type LocatorQuery, type SemanticNode } from '@sinclair/protocol';

export interface LocatorCandidate { code: string; query: LocatorQuery; count: number }
export interface Point { x: number; y: number }

import { jsString } from './js-string.ts';

export { jsString };

export function findNode(root: SemanticNode, ref: string): SemanticNode | undefined {
  if (root.ref === ref) return root;
  for (const c of root.children ?? []) { const f = findNode(c, ref); if (f) return f; }
  return undefined;
}

/** 우선순위: testId(가장 안정) → 역할+이름(정확) → 글자(정확) → placeholder. 질의를 만들 수 없는 노드는 빈 목록 */
export function locatorCandidates(root: SemanticNode, node: SemanticNode): LocatorCandidate[] {
  const out: Array<{ code: string; query: LocatorQuery }> = [];
  if (node.testId) out.push({ code: `screen.getByTestId(${jsString(node.testId)})`, query: { testId: node.testId } });
  if (node.name) out.push({ code: `screen.getByRole(${jsString(node.role)}, { name: ${jsString(node.name)}, exact: true })`, query: { role: node.role, name: node.name, exact: true } });
  if (node.text && !node.name && !node.states?.secure) out.push({ code: `screen.getByText(${jsString(node.text)}, { exact: true })`, query: { text: node.text, exact: true } });
  if (node.placeholder) out.push({ code: `screen.getByPlaceholder(${jsString(node.placeholder)})`, query: { placeholder: node.placeholder } });
  return out.map((c) => ({ ...c, count: locateInTree(root, c.query).length }));
}

/** 그 점(기기 픽셀)을 품은 가장 안쪽 노드. 같은 깊이에서 겹치면 문서 순서상 나중(위에 그려진) 것 */
export function nodeAt(root: SemanticNode, p: Point): SemanticNode | undefined {
  const inside = (n: SemanticNode): boolean => !!n.rect && p.x >= n.rect.x && p.y >= n.rect.y && p.x <= n.rect.x + n.rect.width && p.y <= n.rect.y + n.rect.height;
  if (!inside(root)) return undefined;
  let hit = root;
  for (const c of root.children ?? []) { const d = nodeAt(c, p); if (d) hit = d; }
  return hit;
}

/** 속성 행 [이름, 값]. secure 노드의 값은 보이지 않는다 */
export function nodeProps(n: SemanticNode): Array<[string, string]> {
  const rows: Array<[string, string]> = [['ref', n.ref], ['role', n.role]];
  if (n.name !== undefined) rows.push(['name', n.name]);
  if (n.text !== undefined) rows.push(['text', n.states?.secure ? '(secure — 가림)' : n.text]);
  if (n.value !== undefined || n.states?.secure) rows.push(['value', n.states?.secure ? '(secure — 가림)' : String(n.value)]);
  if (n.testId !== undefined) rows.push(['testId', n.testId]);
  if (n.placeholder !== undefined) rows.push(['placeholder', n.placeholder]);
  if (n.rect) rows.push(['rect', `${n.rect.x},${n.rect.y} ${n.rect.width}×${n.rect.height}`]);
  const states = Object.entries(n.states ?? {}).filter(([, v]) => v).map(([k]) => k);
  if (states.length) rows.push(['states', states.join(', ')]);
  return rows;
}

/** 트리 한 줄: 역할 "이름(또는 글자)" · testId 끝(리소스 id 의 이름 부분) */
export function treeLabel(n: SemanticNode): string {
  const label = n.name ?? (n.states?.secure ? undefined : n.text);
  const id = n.testId ? n.testId.split('/').pop() : undefined;
  return `${n.role}${label ? ` "${label.length > 40 ? `${label.slice(0, 40)}…` : label}"` : ''}${id ? ` · ${id}` : ''}`;
}

/** 그 화면에서 정확히 하나로 정해지는 첫 후보(우선순위대로). 없으면 undefined — 결정적 내보내기가 TODO 로 남긴다 */
export function uniqueLocator(root: SemanticNode, ref: string): string | undefined {
  const node = findNode(root, ref);
  return node ? locatorCandidates(root, node).find((c) => c.count === 1)?.code : undefined;
}
