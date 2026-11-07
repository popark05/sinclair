// 결정적 locator: `screen.getByRole('button', { name: '로그인' }).tap()`. 설계는 e2e 방식(ADR 0001), 규칙은 specs/0002.
// lazy 질의, 호출마다 재조회, strict(정확히 하나), 기한 내 자동 대기, secure 읽기 거부. 엔진 내부는 보지 않는다.
import { EngineError, type Engine, type LocatorQuery, type NodeAction, type SemanticNode } from '@sinclair/protocol';

export interface ScreenOptions {
  /** 액션·읽기가 요소를 기다리는 상한(ms). 기본 10초: 모바일 화면 전환은 보통 1~3초, 콜드 스타트·네트워크 로딩은 그 이상 */
  timeoutMs?: number;
  /** 재조회 간격(ms). 실기기 dump 비용(수십~수백 ms)보다 짧게 두면 의미가 없어 100ms */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
/** 실패 메시지에 넣는 후보 노드 수 */
const CANDIDATE_SUMMARY_LIMIT = 5;

export interface TextOptions { exact?: boolean }
export interface RoleOptions extends TextOptions { name?: string | RegExp }

export interface Locator {
  within(parent: Locator): Locator;
  nth(index: number): Locator;
  first(): Locator;
  /** 지금 화면에서 맞는 노드 수(대기 없음) */
  count(): Promise<number>;
  /** 지금 화면에 정확히 하나 있고 비활성이 아니면 true(대기·예외 없음) */
  isVisible(): Promise<boolean>;
  /** 노드의 text. secure 노드는 secure-read */
  text(): Promise<string | undefined>;
  /** 노드의 value. secure 노드는 secure-read */
  value(): Promise<string | undefined>;
  tap(): Promise<void>;
  longPress(): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  select(value: string): Promise<void>;
  check(): Promise<void>;
  scrollIntoView(): Promise<void>;
  /** 정확히 하나로 맞는 노드(기한 내 대기). expect 가 쓴다 */
  resolve(): Promise<SemanticNode>;
  /** 질의를 사람이 읽을 수 있게 */
  describe(): string;
}

export interface Screen {
  getByRole(role: string, options?: RoleOptions): Locator;
  getByText(text: string | RegExp, options?: TextOptions): Locator;
  getByTestId(testId: string): Locator;
  getByPlaceholder(placeholder: string): Locator;
  /** 접근성 이름(name)으로 */
  getByLabel(label: string | RegExp, options?: TextOptions): Locator;
}

function summarize(nodes: SemanticNode[]): string {
  return nodes.slice(0, CANDIDATE_SUMMARY_LIMIT).map((n) => {
    const bits = [n.ref, n.role];
    if (n.name) bits.push(`name=${JSON.stringify(n.name)}`);
    if (n.text) bits.push(`text=${JSON.stringify(n.text)}`);
    if (n.testId) bits.push(`testId=${n.testId}`);
    if (n.states?.disabled) bits.push('disabled');
    return bits.join(' ');
  }).join('; ') + (nodes.length > CANDIDATE_SUMMARY_LIMIT ? ` … 외 ${nodes.length - CANDIDATE_SUMMARY_LIMIT}개` : '');
}

function describeQuery(q: LocatorQuery): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) if (v !== undefined) parts.push(`${k}=${v instanceof RegExp ? String(v) : JSON.stringify(v)}`);
  return `{ ${parts.join(', ')} }`;
}

export function createScreen(engine: Engine, options: ScreenOptions = {}): Screen {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  /** 질의를 지금 실행한다(within 부모를 먼저 strict 로 푼다). 대기 없음 */
  async function queryNow(spec: LocatorSpec): Promise<{ query: LocatorQuery; nodes: SemanticNode[] }> {
    let query = spec.query;
    if (spec.parent) {
      const parent = await resolveOne(spec.parent, Date.now() + timeoutMs);
      query = { ...query, within: parent.ref };
    }
    return { query, nodes: await engine.locate(query) };
  }

  /** 기한까지 정확히 하나가 될 때까지 재조회. 0개면 not-found, 2개 이상이면 ambiguous(즉시) */
  async function resolveOne(spec: LocatorSpec, deadline: number): Promise<SemanticNode> {
    const started = Date.now();
    for (;;) {
      const { query, nodes } = await queryNow(spec);
      if (nodes.length === 1) return nodes[0]!;
      if (nodes.length > 1) {
        throw new EngineError('ambiguous', `${describeQuery(query)} 에 맞는 노드가 ${nodes.length}개: ${summarize(nodes)}. nth/first/testId/exact 로 좁히세요`, { query: spec.query, candidates: nodes.length });
      }
      if (Date.now() >= deadline) {
        const waited = Date.now() - started;
        throw new EngineError('not-found', `${describeQuery(query)} 에 맞는 노드가 없음 (${waited}ms 기다림)`, { query: spec.query, waitedMs: waited });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** 하나로 맞고 비활성이 아닌 노드. 비활성이면 기한까지 활성화를 기다린다 */
  async function resolveActionable(spec: LocatorSpec): Promise<SemanticNode> {
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    for (;;) {
      const node = await resolveOne(spec, deadline);
      if (!node.states?.disabled) return node;
      if (Date.now() >= deadline) {
        throw new EngineError('not-actionable', `${describeQuery(spec.query)} 는 비활성 상태 (${Date.now() - started}ms 기다림): ${summarize([node])}`, { query: spec.query, ref: node.ref });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  interface LocatorSpec { query: LocatorQuery; parent?: LocatorSpec }

  function make(spec: LocatorSpec): Locator {
    const act = async (action: NodeAction, arg?: string): Promise<void> => {
      const node = await resolveActionable(spec);
      await engine.perform(node.ref, action, arg);
    };
    const read = async (field: 'text' | 'value'): Promise<string | undefined> => {
      const node = await resolveOne(spec, Date.now() + timeoutMs);
      if (node.states?.secure) throw new EngineError('secure-read', `${describeQuery(spec.query)} 는 secure 노드라 ${field} 를 읽을 수 없음`, { query: spec.query, ref: node.ref });
      return node[field];
    };
    const self: Locator = {
      within: (parent) => make({ ...spec, parent: (parent as LocatorWithSpec).spec }),
      nth: (index) => make({ ...spec, query: { ...spec.query, nth: index } }),
      first: () => self.nth(0),
      count: async () => (await queryNow(spec)).nodes.length,
      isVisible: async () => {
        const { nodes } = await queryNow(spec);
        return nodes.length === 1 && !nodes[0]!.states?.disabled;
      },
      text: () => read('text'),
      value: () => read('value'),
      tap: () => act('tap'),
      longPress: () => act('long_press'),
      type: (text) => act('type', text),
      press: (key) => act('press', key),
      select: (value) => act('select', value),
      check: () => act('check'),
      scrollIntoView: () => act('scroll_to'),
      resolve: () => resolveOne(spec, Date.now() + timeoutMs),
      describe: () => describeQuery(spec.query) + (spec.parent ? ` within ${describeQuery(spec.parent.query)}` : ''),
    };
    (self as LocatorWithSpec).spec = spec;
    return self;
  }

  type LocatorWithSpec = Locator & { spec: LocatorSpec };

  const withExact = (q: LocatorQuery, o?: TextOptions): LocatorQuery => (o?.exact ? { ...q, exact: true } : q);

  return {
    getByRole: (role, o) => make({ query: withExact(o?.name !== undefined ? { role, name: o.name } : { role }, o) }),
    getByText: (text, o) => make({ query: withExact({ text }, o) }),
    getByTestId: (testId) => make({ query: { testId } }),
    getByPlaceholder: (placeholder) => make({ query: { placeholder } }),
    getByLabel: (label, o) => make({ query: withExact({ name: label }, o) }),
  };
}
