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
  /** PNG/JPEG. 픽셀 전용 표면이거나 `observe({ pixels: true })` 로 요청했을 때만 */
  pixels?: Uint8Array;
  /** pixels 가 있을 때, 트리와 같은 순간에 찍혔는지(device.snapshot 의 atomic). 아니면 앵커 검사에 쓰지 않는다 */
  atomic?: boolean;
}

export interface ObserveOptions {
  /** true 면 스크린샷도 함께(비용이 크므로 기본 false) */
  pixels?: boolean;
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
  /** true 면 name/text 문자열을 대소문자 구분 정확 일치로 본다(기본은 대소문자 무시 부분 일치). 정규식에는 영향 없음 */
  exact?: boolean;
}

export interface Engine {
  readonly name: string;
  readonly spiVersion: number;
  observe(options?: ObserveOptions): Promise<Observation>;
  /** 즉시 1회 조회. 재시도·엄격성은 러너가 담당 */
  locate(query: LocatorQuery): Promise<SemanticNode[]>;
  perform(ref: string, action: NodeAction, arg?: string): Promise<void>;
  readonly actions: readonly NodeAction[];
  // 선택 capability
  performAt?(x: number, y: number, action: 'tap' | 'long_press' | 'drag_to', to?: { x: number; y: number }): Promise<void>;
  keyboard?: {
    type(text: string): Promise<void>; press(key: string): Promise<void>; dismiss(): Promise<void>;
    /** 화면 키보드가 떠 있는가(선택). 모르는 엔진은 구현하지 않는다 — 에이전트는 그러면 키보드를 내리는 복구를 하지 않는다(모바일의 dismiss 는 뒤로 버튼이라 키보드가 없으면 화면을 떠난다) */
    shown?(): Promise<boolean>;
  };
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
 * 엔진·러너가 쓰는 실패 종류. 러너의 locator/expect 는 이 코드로 재시도·메시지를 결정한다. 어느 층이 내는지:
 * - 엔진: not-found(perform 의 ref 가 현재 화면에 없음), not-actionable(비활성·편집 불가·가려짐), unsupported-action,
 *   timeout(엔진 내부 대기 초과), engine-closed(dispose 뒤 호출), device-unavailable(기기·헬퍼 없음),
 *   device-error(그 밖에 디바이스 레이어가 요청을 처리하지 못함: 내부 오류, 미구현 메서드 등)
 * - 러너(locator/expect, 티켓 03·04): not-found(기한까지 0개), ambiguous(strict 질의에 둘 이상), secure-read(secure 노드 내용 읽기)
 * 상세: specs/0002-engine-contract.md
 */
export const ENGINE_ERROR_CODES = [
  'not-found', 'ambiguous', 'not-actionable', 'secure-read', 'unsupported-action', 'timeout', 'engine-closed', 'device-unavailable', 'device-error',
] as const;
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'EngineError';
  }
}

// ---- locate 매칭 규칙 (FakeEngine 과 engine-mobile 이 공유하는 단일 소스) ----

/**
 * 문자열은 대소문자 무시 부분 일치(exact 면 정확 일치), 정규식은 정규식. 비교 대상이 없으면 불일치.
 * 정규식의 g/y 플래그는 lastIndex 상태 때문에 두 번째 노드부터 오탐하므로 떼고 쓴다.
 */
function matchText(actual: string | undefined, expected: string | RegExp, exact: boolean): boolean {
  if (actual === undefined) return false;
  if (typeof expected === 'string') return exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
  const re = /[gy]/.test(expected.flags) ? new RegExp(expected.source, expected.flags.replace(/[gy]/g, '')) : expected;
  return re.test(actual);
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
  if (query.name !== undefined && !matchText(node.name, query.name, query.exact === true)) return false;
  if (query.text !== undefined && !matchText(node.text, query.text, query.exact === true)) return false;
  if (query.testId !== undefined && !matchTestId(node.testId, query.testId)) return false;
  if (query.placeholder !== undefined && node.placeholder !== query.placeholder) return false;
  return true;
}

/** secure 노드의 내용(text/value)은 러너·에이전트에게 주지 않는다(REVIEW.md 차단 항목). 자식은 건드리지 않는다. */
export function redactSecure(node: SemanticNode): SemanticNode {
  if (!node.states?.secure) return node;
  const { text: _text, value: _value, ...redacted } = node;
  return redacted;
}

/** observe 결과 전체에 redactSecure 를 적용한 복사본. */
export function redactTree(node: SemanticNode): SemanticNode {
  const base = redactSecure(node);
  return node.children ? { ...base, children: node.children.map(redactTree) } : base;
}

/** 위치 결과: 부분 트리가 아니므로 children 을 뺀다. */
function toLocated(node: SemanticNode): SemanticNode {
  const { children: _children, ...rest } = node;
  return redactSecure(rest);
}

export function findNodeByRef(root: SemanticNode, ref: string): SemanticNode | undefined {
  if (root.ref === ref) return root;
  for (const c of root.children ?? []) {
    const found = findNodeByRef(c, ref);
    if (found) return found;
  }
  return undefined;
}

/**
 * 트리에서 질의에 맞는 노드를 문서 순서(DFS)로 돌려준다. within 은 그 ref 의 자손(자기 자신 제외)으로 제한하고,
 * nth 는 within 적용 뒤의 결과에서 0부터 세는 문서 순서 인덱스다(범위 밖이면 빈 배열).
 */
function rectContains(outer: NonNullable<SemanticNode['rect']>, inner: NonNullable<SemanticNode['rect']>): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * 트리에서 질의에 맞는 노드를 문서 순서(DFS)로 돌려준다. within 은 그 ref 의 자손(자기 자신 제외)으로 제한하고,
 * 자손에서 못 찾으면 scope 의 rect 안에 완전히 놓인 노드로 다시 찾는다(bounds 체이닝 fallback, specs/0001: 오버레이·커스텀
 * 레이아웃은 시각적 포함이 트리 중첩과 다르다). nth 는 within 적용 뒤의 결과에서 0부터 세는 문서 순서 인덱스다(범위 밖이면 빈 배열).
 */
export function locateInTree(root: SemanticNode, query: LocatorQuery): SemanticNode[] {
  let out: SemanticNode[] = [];
  if (query.within === undefined) {
    const walk = (n: SemanticNode): void => {
      if (matchesQuery(n, query)) out.push(toLocated(n));
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);
  } else {
    const scope = findNodeByRef(root, query.within);
    if (!scope) return [];
    const descendants = (n: SemanticNode): void => {
      for (const c of n.children ?? []) {
        if (matchesQuery(c, query)) out.push(toLocated(c));
        descendants(c);
      }
    };
    descendants(scope);
    if (out.length === 0 && scope.rect) {
      // scope 의 조상은 rect 가 같아도 "안에 있는" 것이 아니므로 뺀다
      const ancestors = new Set<string>();
      const markPath = (n: SemanticNode, path: SemanticNode[]): boolean => {
        if (n.ref === scope.ref) { for (const a of path) ancestors.add(a.ref); return true; }
        return (n.children ?? []).some((c) => markPath(c, [...path, n]));
      };
      markPath(root, []);
      const bounds = scope.rect;
      const byBounds = (n: SemanticNode): void => {
        if (n.ref !== scope.ref && !ancestors.has(n.ref) && n.rect && rectContains(bounds, n.rect) && matchesQuery(n, query)) out.push(toLocated(n));
        for (const c of n.children ?? []) byBounds(c);
      };
      byBounds(root);
    }
  }
  if (query.nth !== undefined) {
    const picked = out[query.nth];
    out = picked ? [picked] : [];
  }
  return out;
}
