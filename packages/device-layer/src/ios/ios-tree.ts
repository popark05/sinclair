// iOS 러너 트리 → SemanticNode(ios-backend 02). XCUIElement 타입을 Android 헬퍼와 같은 역할 어휘로 옮겨 러너·에이전트·locator·내보내기가 플랫폼을 가리지 않게 한다.
// 러너는 포인트로 주고, 화면 트리 rect 는 스크린샷과 같은 픽셀(배율)이다. secure 입력칸의 값은 싣지 않는다. ref 는 DFS 순서 @e0, @e1, …
import type { SemanticNode } from '@sinclair/protocol';

/** 러너가 주는 원소(XCUIElementSnapshot 에서 필요한 것만) */
export interface IosElement {
  /** XCUIElement.ElementType 이름(Button, StaticText, …) */
  type: string;
  identifier?: string;
  label?: string;
  value?: string;
  placeholderValue?: string;
  /** 포인트 */
  frame: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  selected: boolean;
  hasFocus?: boolean;
  children: IosElement[];
}

const ROLE: Record<string, string> = {
  Application: 'root', Window: 'group', Other: 'group', Group: 'group', NavigationBar: 'group', TabBar: 'group', Toolbar: 'group', Alert: 'group', Sheet: 'group', Keyboard: 'group', Cell: 'group', SegmentedControl: 'group',
  Button: 'button', Key: 'button', Link: 'button', MenuItem: 'button', Icon: 'button',
  StaticText: 'text', TextField: 'textbox', SearchField: 'textbox', TextView: 'textbox', SecureTextField: 'textbox',
  Switch: 'switch', Toggle: 'switch', CheckBox: 'checkbox', RadioButton: 'radio', Slider: 'slider', PickerWheel: 'combobox', Picker: 'combobox',
  Image: 'image', Table: 'list', CollectionView: 'list', ScrollView: 'scrollable', WebView: 'webview', Tab: 'tab',
};
/** 이름 대신 글자로 싣는 타입(Android 의 text 와 같은 자리) */
const TEXT_TYPES = new Set(['StaticText']);
const EDITABLE = new Set(['TextField', 'SearchField', 'TextView', 'SecureTextField']);

const px = (v: number, scale: number): number => Math.round(v * scale);

export function toSemanticTree(root: IosElement, scale: number): SemanticNode {
  let n = 0;
  const conv = (e: IosElement): SemanticNode | undefined => {
    const children = e.children.map(conv).filter((c): c is SemanticNode => !!c);
    if (e.type !== 'Application' && e.frame.width <= 0 && e.frame.height <= 0 && !children.length) return undefined;
    const role = ROLE[e.type] ?? 'view';
    const secure = e.type === 'SecureTextField';
    const label = e.label?.trim() || undefined;
    const states: NonNullable<SemanticNode['states']> = {};
    if (!e.enabled) states.disabled = true;
    if (e.selected) states.selected = true;
    if (e.hasFocus) states.focused = true;
    if (secure) states.secure = true;
    if ((role === 'switch' || role === 'checkbox') && e.value !== undefined) states.checked = e.value === '1' || e.value === 'true';
    const node: SemanticNode = {
      ref: '', role,
      ...(label && !TEXT_TYPES.has(e.type) ? { name: label } : {}),
      ...(label && TEXT_TYPES.has(e.type) ? { text: label } : {}),
      ...(EDITABLE.has(e.type) && !secure && e.value !== undefined && e.value !== e.placeholderValue ? { value: e.value } : {}),
      ...(e.placeholderValue ? { placeholder: e.placeholderValue } : {}),
      ...(e.identifier ? { testId: e.identifier } : {}),
      rect: { x: px(e.frame.x, scale), y: px(e.frame.y, scale), width: px(e.frame.width, scale), height: px(e.frame.height, scale) },
      ...(Object.keys(states).length ? { states } : {}),
      ...(children.length ? { children } : {}),
    };
    return node;
  };
  const tree = conv(root) ?? { ref: '', role: 'root' };
  const number = (x: SemanticNode): void => { x.ref = `@e${n++}`; for (const c of x.children ?? []) number(c); };
  number(tree);
  return tree;
}
