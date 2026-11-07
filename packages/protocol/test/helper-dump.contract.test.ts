// 접근성 헬퍼 APK 의 /dump 응답이 SemanticNode 계약과 맞는지 실제 기기에서 받은 샘플로 고정한다.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SemanticNode } from '../src/index.ts';

const sample: SemanticNode = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'helper-dump.sample.json'), 'utf8'));

function walk(node: SemanticNode, visit: (n: SemanticNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const c of node.children ?? []) walk(c, visit, depth + 1);
}

describe('헬퍼 /dump 응답 계약', () => {
  it('루트는 @e0 이고 ref 는 DFS 순서의 연속 번호이며 중복이 없다', () => {
    const refs: string[] = [];
    walk(sample, (n) => refs.push(n.ref));
    expect(refs[0]).toBe('@e0');
    expect(refs).toEqual(refs.map((_, i) => `@e${i}`));
  });

  it('모든 노드가 role 과 정수 rect 를 가지고, 허용된 필드만 쓴다', () => {
    const allowed = new Set(['ref', 'role', 'name', 'text', 'value', 'testId', 'placeholder', 'rect', 'states', 'children']);
    walk(sample, (n) => {
      expect(typeof n.role).toBe('string');
      expect(n.rect).toBeDefined();
      for (const v of Object.values(n.rect!)) expect(Number.isInteger(v)).toBe(true);
      for (const k of Object.keys(n)) expect(allowed.has(k), `알 수 없는 필드 ${k}`).toBe(true);
      for (const [k, v] of Object.entries(n.states ?? {})) {
        expect(['focused', 'selected', 'checked', 'disabled', 'secure']).toContain(k);
        expect(v).toBe(true);
      }
    });
  });

  it('실기기 샘플에는 testId(resource-id) 와 text 가 있는 노드가 있다(flagReportViewIds 동작 증거)', () => {
    let withId = 0, withText = 0;
    walk(sample, (n) => { if (n.testId) withId++; if (n.text) withText++; });
    expect(withId).toBeGreaterThan(0);
    expect(withText).toBeGreaterThan(0);
  });
});
