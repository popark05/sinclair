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
    expect(describeTarget(tree, '@b')).toEqual({ ref: '@b', role: 'button', label: '배', rect: rect(200), parentLabel: '배 행', distinct: true });
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

describe('relocate · 리뷰 반영(Android 모양 트리·변하는 글자·위치만)', () => {
  /** 실제 Android 처럼 행 컨테이너에는 이름이 없고 행 글자는 버튼의 형제다 */
  const aRow = (prefix: string, fruit: string, y: number): SemanticNode => ({ ref: `${prefix}0`, role: 'group', rect: rect(y), children: [
    { ref: `${prefix}1`, role: 'text', text: fruit, rect: { x: 0, y, width: 800, height: 120 } },
    { ref: `${prefix}2`, role: 'button', name: '삭제', rect: { x: 900, y, width: 180, height: 120 } },
  ] });
  const cart = (...rows: SemanticNode[]): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@l', role: 'list', name: '장바구니', children: rows }] });

  it('행이 사라지면 다른 행의 같은 이름 버튼으로 옮기지 않는다(gone)', () => {
    const t = describeTarget(cart(aRow('@a', '사과', 0), aRow('@b', '배', 200)), '@b2')!;
    expect(relocate(t, cart(aRow('@a', '사과', 0)))).toMatchObject({ kind: 'gone' });
  });

  it('행이 자리를 바꾸고 ref 가 순번이라 같은 ref 가 다른 행에 붙어도, 원래 행의 버튼을 찾는다', () => {
    const t = describeTarget(cart(aRow('@a', '사과', 0), aRow('@b', '배', 200)), '@b2')!;
    // 순번 ref: 두 번째 행 자리의 버튼이 여전히 @b2 지만 이제 "사과" 행이다
    expect(relocate(t, cart(aRow('@a', '배', 0), aRow('@b', '사과', 200)))).toMatchObject({ kind: 'moved', ref: '@a2' });
  });

  it('숫자만 바뀌는 글자(배지·카운트다운)는 같은 대상이다', () => {
    const one = (label: string): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@n', role: 'button', name: label, rect: rect(0) }, { ref: '@m', role: 'button', name: '설정', rect: rect(200) }] });
    expect(relocate(describeTarget(one('알림 3'), '@n')!, one('알림 4'))).toMatchObject({ kind: 'same', ref: '@n' });
    expect(relocate(describeTarget(one('재전송 (59초)'), '@n')!, one('재전송 (58초)'))).toMatchObject({ kind: 'same', ref: '@n' });
  });

  it('이름 없는 대상은 조금 스크롤돼도(위치만) 찾고, 0 크기·NaN 위치는 위치로 쓰지 않는다', () => {
    const icon = (y: number): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@i', role: 'button', rect: { x: 0, y, width: 120, height: 120 } }, { ref: '@j', role: 'text', text: '다른 것' }] });
    expect(relocate(describeTarget(icon(500), '@i')!, icon(525))).toMatchObject({ kind: 'same', ref: '@i' });
    const zero = describeTarget({ ref: '@r', role: 'root', children: [{ ref: '@z', role: 'button', name: '확인', rect: { x: 0, y: 0, width: 0, height: 0 } }] }, '@z')!;
    expect(zero).not.toHaveProperty('rect');
    const nan = { ref: '@z', role: 'button', label: '확인', rect: { x: NaN, y: 0, width: 10, height: 10 } };
    const r = relocate(nan, { ref: '@r', role: 'root', children: [{ ref: '@z', role: 'button', name: '확인' }] });
    expect(r).toMatchObject({ kind: 'same' });
    if ('score' in r) expect(Number.isFinite(r.score)).toBe(true);
  });

  it('신호가 없는 대상(이름·위치 없는 칸)은 같은 역할이 여럿이면 애매함', () => {
    const t = { ref: '@x', role: 'textbox' };
    expect(relocate(t, { ref: '@r', role: 'root', children: [{ ref: '@x', role: 'textbox' }, { ref: '@y', role: 'textbox', placeholder: '비밀번호' }] })).toMatchObject({ kind: 'ambiguous' });
  });

  it('동점 안에 원래 ref 가 그대로 있으면 same(화면이 안 바뀐 동명 버튼)', () => {
    const twins = (): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@1', role: 'button', name: '배' }, { ref: '@2', role: 'button', name: '배' }] });
    expect(relocate({ ref: '@2', role: 'button', label: '배' }, twins())).toMatchObject({ kind: 'same', ref: '@2' });
  });
});
