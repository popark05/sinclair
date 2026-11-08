// 대상 재탐색: 모델이 고른 때의 대상 설명으로 실행 직전 화면에서 같은 대상을 찾는다. same / moved / gone / ambiguous.
import { describe, it, expect } from 'vitest';
import type { SemanticNode } from '@sinclair/protocol';
import { describeTarget, relocate } from '../src/index.ts';

const rect = (y: number) => ({ x: 0, y, width: 1080, height: 120 });
const row = (ref: string, name: string, y: number, parent = '목록'): SemanticNode => ({ ref: `${ref}p`, role: 'listitem', name: parent === '목록' ? `${name} 행` : parent, rect: rect(y), children: [{ ref, role: 'button', name, rect: rect(y) }] });
const list = (...items: SemanticNode[]): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@l', role: 'list', name: '목록', children: items }] });

describe('describeTarget', () => {
  it('역할·이름·testId·placeholder·위치·부모 이름을 담는다', () => {
    const tree = list(row('@a', '사과', 0), row('@b', '배', 200));
    expect(describeTarget(tree, '@b')).toEqual({ ref: '@b', role: 'button', label: '배', rect: rect(200), parentLabel: '배 행' });
    expect(describeTarget(tree, '@없음')).toBeUndefined();
  });
});

describe('relocate', () => {
  const before = list(row('@a', '사과', 0), row('@b', '배', 200), row('@c', '감', 400));
  const target = describeTarget(before, '@b')!;

  it('그대로면 same', () => {
    expect(relocate(target, before)).toMatchObject({ kind: 'same', ref: '@b' });
  });

  it('목록이 다시 그려져 ref 가 바뀌면(순서 변경) moved 로 새 ref 를 찾는다', () => {
    const after = list(row('@x', '감', 0), row('@y', '배', 200), row('@z', '사과', 400));
    expect(relocate(target, after)).toMatchObject({ kind: 'moved', ref: '@y' });
    // 같은 ref 자리에 다른 대상이 온 경우도 원래 대상을 찾는다
    const shuffled = list(row('@a', '감', 0), row('@b', '사과', 200), row('@c', '배', 400));
    expect(relocate(target, shuffled)).toMatchObject({ kind: 'moved', ref: '@c' });
  });

  it('같은 이름이 다른 위치로 가도(위에 행이 끼어듦) moved', () => {
    const after = list(row('@n', '새 항목', 0), row('@a', '사과', 200), row('@b2', '배', 400), row('@c', '감', 600));
    expect(relocate(target, after)).toMatchObject({ kind: 'moved', ref: '@b2' });
  });

  it('사라지면 gone, 역할이 다른 같은 이름은 후보가 아니다', () => {
    expect(relocate(target, list(row('@a', '사과', 0), row('@c', '감', 400)))).toMatchObject({ kind: 'gone' });
    const textOnly: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@t', role: 'text', text: '배', rect: rect(200) }] };
    expect(relocate(target, textOnly)).toMatchObject({ kind: 'gone' });
  });

  it('구별할 수 없는 후보가 둘이면 ambiguous(위치·부모도 같게 가리지 못함)', () => {
    const noRect = { ref: '@b', role: 'button', label: '배' };
    const twins: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@1', role: 'button', name: '배' }, { ref: '@2', role: 'button', name: '배' }] };
    expect(relocate(noRect, twins)).toMatchObject({ kind: 'ambiguous', candidates: ['@1', '@2'] });
  });

  it('동명이라도 위치·부모가 가려 주면 찾는다(목록의 같은 "삭제" 버튼)', () => {
    const del = (ref: string, y: number, parent: string): SemanticNode => ({ ref: `${ref}p`, role: 'listitem', name: parent, rect: rect(y), children: [{ ref, role: 'button', name: '삭제', rect: rect(y) }] });
    const t0 = list(del('@d1', 0, '사과'), del('@d2', 200, '배'));
    const t = describeTarget(t0, '@d2')!;
    expect(relocate(t, list(del('@e1', 0, '배'), del('@e2', 200, '사과')))).toMatchObject({ kind: 'moved', ref: '@e1' }); // 부모 이름이 위치보다 우선
  });
});
