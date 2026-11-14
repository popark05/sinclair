// 비밀값 넣기(agent-secrets 01): 입력칸이면 그대로, 아니면 키패드 — 값의 글자마다 지금 화면을 다시 보고 그 글자가 이름·글자인 키를 탭한다.
// 누를 때마다 배치가 섞이는 보안 키패드도 된다. 오류 문구에는 몇 번째 글자인지만(값은 숨김). 러너의 screen.tapKeys 도 같은 규칙을 쓴다.
import { EngineError, type Engine, type SemanticNode } from '@sinclair/protocol';

const labelOf = (n: SemanticNode): string => (n.name ?? n.text ?? '').trim();
function findRef(root: SemanticNode, ref: string): SemanticNode | undefined {
  if (root.ref === ref) return root;
  for (const c of root.children ?? []) { const f = findRef(c, ref); if (f) return f; }
  return undefined;
}
function collect(root: SemanticNode, pred: (n: SemanticNode) => boolean, out: SemanticNode[] = []): SemanticNode[] {
  if (pred(root)) out.push(root);
  for (const c of root.children ?? []) collect(c, pred, out);
  return out;
}
export const isTextField = (n: SemanticNode): boolean => n.role === 'textbox' || !!n.states?.secure;

/** 키패드로 값을 누른다. scopeRef 가 있으면 그 영역의 키를 먼저 찾고(없으면 화면 전체), 버튼 역할을 우선한다 */
export async function tapKeys(engine: Engine, value: string, scopeRef?: string): Promise<void> {
  const chars = [...value];
  for (let i = 0; i < chars.length; i++) {
    const root = (await engine.observe()).root;
    const isKey = (n: SemanticNode): boolean => labelOf(n) === chars[i] && !n.states?.disabled;
    const scope = scopeRef ? findRef(root, scopeRef) : undefined;
    let keys = scope ? collect(scope, isKey) : [];
    if (!keys.length) keys = collect(root, isKey);
    const buttons = keys.filter((k) => k.role === 'button');
    if (buttons.length) keys = buttons;
    if (keys.length === 0) throw new EngineError('not-found', `키패드에서 ${i + 1}번째 글자의 키를 찾지 못함(글자는 숨김) — 키에 글자가 없는 보안 키패드면 자동으로 넣을 수 없다`);
    if (keys.length > 1) throw new EngineError('ambiguous', `키패드에서 ${i + 1}번째 글자의 키가 ${keys.length}개(글자는 숨김)`);
    await engine.perform(keys[0]!.ref, 'tap');
  }
}

/** ref 가 입력칸이면 입력, 아니면 그 영역을 키패드로 보고 누른다 */
export async function enterSecret(engine: Engine, ref: string, value: string): Promise<void> {
  const node = findRef((await engine.observe()).root, ref);
  if (node && isTextField(node)) { await engine.perform(ref, 'type', value); return; }
  await tapKeys(engine, value, ref);
}
