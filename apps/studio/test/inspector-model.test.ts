// Inspector 모델(studio 04): locator 후보는 러너 screen 과 같은 질의로 만들고 같은 규칙(locateInTree)으로 현재 화면 매치 수를 센다.
import { describe, it, expect } from 'vitest';
import type { SemanticNode } from '@sinclair/protocol';
import { locatorCandidates, nodeAt, nodeProps, findNode, treeLabel } from '../src/renderer/src/inspector-model.ts';

const root: SemanticNode = { ref: '@e0', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
  { ref: '@e1', role: 'group', rect: { x: 0, y: 0, width: 1080, height: 200 }, children: [
    { ref: '@e2', role: 'button', name: '검색', testId: 'com.app:id/search', rect: { x: 900, y: 50, width: 120, height: 100 } },
    { ref: '@e3', role: 'button', name: '검색', rect: { x: 700, y: 50, width: 120, height: 100 } },
  ] },
  { ref: '@e4', role: 'textbox', placeholder: "검색어 'q'", rect: { x: 0, y: 300, width: 1080, height: 120 } },
  { ref: '@e5', role: 'textbox', placeholder: '비밀번호', value: 'hunter2', states: { secure: true }, rect: { x: 0, y: 500, width: 1080, height: 120 } },
  { ref: '@e6', role: 'text', text: '환영합니다', rect: { x: 0, y: 700, width: 1080, height: 80 } },
] };

describe('locatorCandidates', () => {
  it('testId → 역할+이름(정확) 순, 각자 현재 화면 매치 수', () => {
    const c = locatorCandidates(root, findNode(root, '@e2')!);
    expect(c.map((x) => [x.code, x.count])).toEqual([
      ["screen.getByTestId('com.app:id/search')", 1],
      ["screen.getByRole('button', { name: '검색', exact: true })", 2],
    ]);
  });

  it('글자 노드는 getByText(정확), 입력란은 placeholder — 따옴표는 이스케이프', () => {
    expect(locatorCandidates(root, findNode(root, '@e6')!).map((x) => [x.code, x.count])).toEqual([["screen.getByText('환영합니다', { exact: true })", 1]]);
    expect(locatorCandidates(root, findNode(root, '@e4')!).map((x) => x.code)).toEqual(["screen.getByPlaceholder('검색어 \\'q\\'')"]);
  });

  it('후보가 없는 노드(이름·글자·testId 없음)는 빈 목록', () => {
    expect(locatorCandidates(root, findNode(root, '@e1')!)).toEqual([]);
  });
});

describe('nodeAt', () => {
  it('그 점을 품은 가장 안쪽 노드', () => {
    expect(nodeAt(root, { x: 950, y: 100 })?.ref).toBe('@e2');
    expect(nodeAt(root, { x: 10, y: 100 })?.ref).toBe('@e1');
    expect(nodeAt(root, { x: 10, y: 2300 })?.ref).toBe('@e0');
  });
});

describe('nodeProps·treeLabel', () => {
  it('속성 행, secure 노드의 값은 가림', () => {
    expect(nodeProps(findNode(root, '@e5')!)).toEqual(expect.arrayContaining([['role', 'textbox'], ['placeholder', '비밀번호'], ['value', '(secure — 가림)'], ['states', 'secure']]));
    expect(JSON.stringify(nodeProps(findNode(root, '@e5')!))).not.toContain('hunter2');
    expect(nodeProps(findNode(root, '@e2')!)).toEqual(expect.arrayContaining([['rect', '900,50 120×100']]));
  });
  it('트리 줄: 역할 "이름" · testId 끝', () => {
    expect(treeLabel(findNode(root, '@e2')!)).toBe('button "검색" · search');
    expect(treeLabel(findNode(root, '@e1')!)).toBe('group');
  });
});
