// 모델에게 보여 줄 화면: 트리를 한 줄에 노드 하나로. secure 노드는 값을 빼고(redactTree) "secure" 표시만 남긴다 —
// 모델은 그 칸이 있다는 것은 알되 내용은 보지 못한다.
import { redactTree, type SemanticNode } from '@sinclair/protocol';

const STATE_ORDER = ['disabled', 'checked', 'selected', 'focused', 'secure'] as const;

function line(n: SemanticNode, depth: number): string {
  const label = n.name ?? n.text;
  const bits = [`${'  '.repeat(depth)}${n.ref} ${n.role}`];
  if (label) bits.push(JSON.stringify(label));
  if (n.name && n.text && n.text !== n.name) bits.push(`text=${JSON.stringify(n.text)}`);
  if (n.value !== undefined) bits.push(`value=${JSON.stringify(n.value)}`);
  if (n.placeholder) bits.push(`placeholder=${JSON.stringify(n.placeholder)}`);
  if (n.testId) bits.push(`id=${n.testId}`);
  const states = STATE_ORDER.filter((s) => n.states?.[s]);
  if (states.length) bits.push(`(${states.join(', ')})`);
  return bits.join(' ');
}

export function renderObservation(root: SemanticNode): string {
  const out: string[] = [];
  const walk = (n: SemanticNode, depth: number): void => {
    out.push(line(n, depth));
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(redactTree(root), 0);
  return out.join('\n');
}
