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

// ---- 오류 ----

/**
 * 엔진이 러너에게 돌려주는 실패 종류. 러너의 locator/expect 는 이 코드로 재시도·메시지를 결정한다.
 * not-found: 질의에 맞는 노드 없음 / ambiguous: strict 질의에 둘 이상 / not-actionable: 있지만 비활성·가려짐 /
 * secure-read: secure 노드의 내용 읽기 시도 / unsupported-action: 엔진이 그 액션·capability 를 지원하지 않음 /
 * timeout: 엔진 내부 대기 초과 / engine-closed: dispose 뒤 호출 / device-unavailable: 기기·헬퍼 없음
 */
export const ENGINE_ERROR_CODES = [
  'not-found', 'ambiguous', 'not-actionable', 'secure-read', 'unsupported-action', 'timeout', 'engine-closed', 'device-unavailable',
] as const;
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'EngineError';
  }
}

// ---- locate 매칭 규칙 (FakeEngine 과 engine-mobile 이 공유하는 단일 소스) ----

/** 문자열은 대소문자 무시 부분 일치, 정규식은 정규식. 비교 대상이 없으면 불일치. */
function matchText(actual: string | undefined, expected: string | RegExp): boolean {
  if (actual === undefined) return false;
  return typeof expected === 'string' ? actual.toLowerCase().includes(expected.toLowerCase()) : expected.test(actual);
}

/** testId 는 전체(`com.app:id/username`)와 짧은 이름(`username`) 모두 정확 일치로 본다(resource-id 관례). */
function matchTestId(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  if (actual === expected) return true;
  const slash = actual.lastIndexOf('/');
  return slash >= 0 && actual.slice(slash + 1) === expected;
}

export function matchesQuery(node: SemanticNode, query: LocatorQuery): boolean {
  if (query.role !== undefined && node.role !== query.role) return false;
  if (query.name !== undefined && !matchText(node.name, query.name)) return false;
  if (query.text !== undefined && !matchText(node.text, query.text)) return false;
  if (query.testId !== undefined && !matchTestId(node.testId, query.testId)) return false;
  if (query.placeholder !== undefined && node.placeholder !== query.placeholder) return false;
  return true;
}

/** 위치 결과: 부분 트리가 아니므로 children 을 뺀다. secure 노드는 내용(text/value)을 러너에게 주지 않는다. */
function toLocated(node: SemanticNode): SemanticNode {
  const { children: _children, ...rest } = node;
  if (!rest.states?.secure) return rest;
  const { text: _text, value: _value, ...redacted } = rest;
  return redacted;
}

function findByRef(root: SemanticNode, ref: string): SemanticNode | undefined {
  if (root.ref === ref) return root;
  for (const c of root.children ?? []) {
    const found = findByRef(c, ref);
    if (found) return found;
  }
  return undefined;
}

/**
 * 트리에서 질의에 맞는 노드를 문서 순서(DFS)로 돌려준다. within 은 그 ref 의 자손(자기 자신 제외)으로 제한하고,
 * nth 는 0부터 세는 문서 순서 인덱스다(범위 밖이면 빈 배열).
 */
export function locateInTree(root: SemanticNode, query: LocatorQuery): SemanticNode[] {
  let scope: SemanticNode | undefined = root;
  if (query.within !== undefined) {
    scope = findByRef(root, query.within);
    if (!scope) return [];
  }
  const out: SemanticNode[] = [];
  const walk = (n: SemanticNode, isScopeRoot: boolean): void => {
    if (!(isScopeRoot && query.within !== undefined) && matchesQuery(n, query)) out.push(toLocated(n));
    for (const c of n.children ?? []) walk(c, false);
  };
  walk(scope, true);
  if (query.nth !== undefined) {
    const picked = out[query.nth];
    return picked ? [picked] : [];
  }
  return out;
}
