// 러너 ↔ 엔진 계약. 구현한 선택 메서드로 capability가 결정된다 (e2e 방식 참고).

export interface SemanticNode {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  placeholder?: string;
  rect?: { x: number; y: number; width: number; height: number };
  states?: Partial<Record<'focused' | 'selected' | 'checked' | 'disabled' | 'secure', boolean>>;
  children?: SemanticNode[];
}

export interface Observation {
  root: SemanticNode;
  /** 현재 위치(URL, 화면 식별자 등). 캐시 재생의 시작 경로 검사에 쓴다 */
  location?: string;
  /** PNG/JPEG. 픽셀 전용 표면이거나 요청 시에만 */
  pixels?: Uint8Array;
}

export const NODE_ACTIONS = [
  'tap', 'double_tap', 'long_press', 'type', 'press', 'select', 'check', 'drag', 'scroll_to', 'scroll',
] as const;
export type NodeAction = (typeof NODE_ACTIONS)[number];

export interface LocatorQuery {
  role?: string;
  name?: string | RegExp;
  text?: string | RegExp;
  testId?: string;
  placeholder?: string;
  within?: string;
  nth?: number;
}

export interface Engine {
  readonly name: string;
  readonly spiVersion: number;
  observe(): Promise<Observation>;
  /** 즉시 1회 조회. 재시도·엄격성은 러너가 담당 */
  locate(query: LocatorQuery): Promise<SemanticNode[]>;
  perform(ref: string, action: NodeAction, arg?: string): Promise<void>;
  readonly actions: readonly NodeAction[];
  // 선택 capability
  performAt?(x: number, y: number, action: 'tap' | 'long_press' | 'drag_to', to?: { x: number; y: number }): Promise<void>;
  keyboard?: { type(text: string): Promise<void>; press(key: string): Promise<void>; dismiss(): Promise<void> };
  session?: { open(target?: string): Promise<void>; back(): Promise<void>; restart(): Promise<void>; reset(): Promise<void> };
  dispose?(): Promise<void>;
}

export type Capability = 'pointer' | 'keyboard' | 'session';

export function capabilitiesOf(engine: Engine): Capability[] {
  const caps: Capability[] = [];
  if (engine.performAt) caps.push('pointer');
  if (engine.keyboard) caps.push('keyboard');
  if (engine.session) caps.push('session');
  return caps;
}
