// iOS 러너 트리 → SemanticNode(ios-backend 02): XCUIElement 타입을 Android 와 같은 역할 어휘로, 포인트 → 픽셀(배율), secure 값 가림, ref 는 DFS.
import { describe, it, expect } from 'vitest';
import { toSemanticTree, type IosElement } from '../../src/ios/ios-tree.ts';

const el = (type: string, extra: Partial<IosElement> = {}, children: IosElement[] = []): IosElement => ({ type, frame: { x: 0, y: 0, width: 100, height: 50 }, enabled: true, selected: false, children, ...extra });

describe('toSemanticTree', () => {
  it('역할 매핑·이름/글자·값·placeholder·testId·상태, 프레임은 배율로 픽셀', () => {
    const app = el('Application', { label: '설정', frame: { x: 0, y: 0, width: 414, height: 896 } }, [
      el('Window', {}, [
        el('StaticText', { label: '로그인', frame: { x: 10, y: 20, width: 100, height: 30 } }),
        el('Button', { label: '다음', identifier: 'next', frame: { x: 10, y: 100.5, width: 120, height: 44 } }),
        el('TextField', { value: 'qa', placeholderValue: '아이디', identifier: 'user' }),
        el('SecureTextField', { value: '••••', placeholderValue: '비밀번호' }),
        el('Switch', { label: '자동 로그인', value: '1' }),
        el('Button', { label: '비활성', enabled: false, selected: true }),
        el('Table', {}, [el('Cell', { label: '항목' })]),
        el('Other'),
      ]),
    ]);
    const root = toSemanticTree(app, 3);
    expect(root).toMatchObject({ ref: '@e0', role: 'root', name: '설정', rect: { x: 0, y: 0, width: 1242, height: 2688 } });
    const kids = root.children![0]!.children!;
    expect(kids[0]).toMatchObject({ role: 'text', text: '로그인', rect: { x: 30, y: 60, width: 300, height: 90 } });
    expect(kids[0]!.name).toBeUndefined();
    expect(kids[1]).toMatchObject({ role: 'button', name: '다음', testId: 'next', rect: { x: 30, y: 302, width: 360, height: 132 } });
    expect(kids[2]).toMatchObject({ role: 'textbox', value: 'qa', placeholder: '아이디', testId: 'user' });
    expect(kids[3]).toMatchObject({ role: 'textbox', placeholder: '비밀번호', states: { secure: true } });
    expect(kids[3]!.value).toBeUndefined(); // secure 값은 싣지 않는다
    expect(kids[4]).toMatchObject({ role: 'switch', name: '자동 로그인', states: { checked: true } });
    expect(kids[5]).toMatchObject({ role: 'button', states: { disabled: true, selected: true } });
    expect(kids[6]).toMatchObject({ role: 'list', children: [{ role: 'group', name: '항목' }] });
    expect(kids[7]).toMatchObject({ role: 'group' });
    // ref 는 DFS 순서
    const refs: string[] = []; const walk = (n: { ref: string; children?: unknown[] }) => { refs.push(n.ref); for (const c of (n.children ?? []) as typeof n[]) walk(c); }; walk(root);
    expect(refs).toEqual(refs.map((_, i) => `@e${i}`));
  });

  it('크기 0 이고 자식도 없는 노드(화면 밖 자리표시)는 뺀다', () => {
    const root = toSemanticTree(el('Application', {}, [el('Other', { frame: { x: 0, y: 0, width: 0, height: 0 } }), el('Button', { label: 'OK' })]), 2);
    expect(root.children!.map((c) => c.role)).toEqual(['button']);
  });
});
