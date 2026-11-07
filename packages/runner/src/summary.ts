// 실패 메시지용 노드 요약. locator 와 expect 가 같은 형식을 쓴다.
import type { SemanticNode } from '@sinclair/protocol';

/** 메시지에 넣는 후보 노드 수. 5개면 무엇이 있었는지 보기에 충분하고 메시지가 한 화면을 넘지 않는다 */
export const SUMMARY_LIMIT = 5;

export function summarize(nodes: SemanticNode[]): string {
  if (nodes.length === 0) return '(없음)';
  return nodes.slice(0, SUMMARY_LIMIT).map((n) => {
    const bits = [n.ref, n.role];
    if (n.name) bits.push(`name=${JSON.stringify(n.name)}`);
    // secure 노드의 text/value 는 엔진이 이미 뺐지만, 메시지에 실리는 일은 이중으로 막는다
    if (n.text && !n.states?.secure) bits.push(`text=${JSON.stringify(n.text)}`);
    if (n.value !== undefined && !n.states?.secure) bits.push(`value=${JSON.stringify(n.value)}`);
    if (n.testId) bits.push(`testId=${n.testId}`);
    const on = Object.entries(n.states ?? {}).filter(([, v]) => v).map(([k]) => k);
    if (on.length > 0) bits.push(on.join(','));
    return bits.join(' ');
  }).join('; ') + (nodes.length > SUMMARY_LIMIT ? ` … 외 ${nodes.length - SUMMARY_LIMIT}개` : '');
}
