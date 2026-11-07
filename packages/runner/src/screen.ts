// 결정적 locator: `screen.getByRole('button', { name: '로그인' }).tap()`. 설계는 e2e 방식(ADR 0001), 규칙은 specs/0002.
// lazy 질의, 호출마다 재조회, strict(정확히 하나), 기한 내 자동 대기, secure 읽기 거부. 엔진 내부는 보지 않는다.
import { EngineError, type Engine, type LocatorQuery, type NodeAction, type SemanticNode } from '@sinclair/protocol';
import { summarize } from './summary.ts';

export interface ScreenOptions {
  /** 액션·읽기가 요소를 기다리는 상한(ms). 기본 10초: 모바일 화면 전환은 보통 1~3초, 콜드 스타트·네트워크 로딩은 그 이상 */
  timeoutMs?: number;
  /** 재조회 간격(ms). 실기기 dump 비용(수십~수백 ms)보다 짧게 두면 의미가 없어 100ms */
  pollMs?: number;
  /** locator 액션 한 건이 끝날 때(성공·실패 모두) 알린다. 러너가 스텝 기록에 쓴다 */
  onStep?: (step: StepEvent) => void;
}

/** 스텝 기록용 이벤트. instruction 은 사람이 읽는 한 줄, error 는 실패 시 메시지 */
export interface StepEvent { kind: 'locator' | 'assert'; instruction: string; durationMs: number; error?: string }

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;

export interface TextOptions { exact?: boolean }
export interface RoleOptions extends TextOptions { name?: string | RegExp }

export interface Locator {
  within(parent: Locator): Locator;
  nth(index: number): Locator;
  first(): Locator;
  /** 지금 화면에서 맞는 노드 수(대기 없음) */
  count(): Promise<number>;
  /** 지금 화면에 정확히 하나 있으면 true(대기·예외 없음). 활성 여부는 보지 않는다(expect.toBeDisabled 가 따로 본다) */
  isVisible(): Promise<boolean>;
  /**
   * 지금 화면에서 맞는 노드들(대기 없음). expect 의 폴링이 쓴다. within 부모는 deadline(기본 screen 기한)까지 strict 로 풀되,
   * 부모가 없으면 자식도 없는 것이므로 빈 배열이다(부모 중복은 ambiguous 그대로).
   */
  probe(deadline?: number): Promise<SemanticNode[]>;
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

function describeQuery(q: LocatorQuery): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) if (v !== undefined) parts.push(`${k}=${v instanceof RegExp ? String(v) : JSON.stringify(v)}`);
  return `{ ${parts.join(', ')} }`;
}

interface LocatorSpec { query: LocatorQuery; parent?: LocatorSpec }

/** 공개 Locator 객체 → 질의. 공개 타입에 비공개 필드를 달지 않기 위해 모듈 밖에서는 보이지 않는 맵으로 둔다 */
const specs = new WeakMap<Locator, LocatorSpec>();

export function createScreen(engine: Engine, options: ScreenOptions = {}): Screen {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  /** deadline 까지 fn 이 값을 돌려줄 때까지 pollMs 간격으로 반복. 기한을 넘기면 onTimeout 이 던진다 */
  async function pollUntil<T>(deadline: number, fn: () => Promise<T | undefined>, onTimeout: (waitedMs: number) => never | Promise<never>): Promise<T> {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() >= deadline) await onTimeout(Date.now() - started);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** 질의를 지금 실행한다(within 부모를 먼저 strict 로 풀되 같은 기한을 쓴다). 대기 없음 */
  async function queryNow(spec: LocatorSpec, deadline: number): Promise<{ query: LocatorQuery; nodes: SemanticNode[] }> {
    let query = spec.query;
    if (spec.parent) {
      const parent = await resolveOne(spec.parent, deadline);
      query = { ...query, within: parent.ref };
    }
    return { query, nodes: await engine.locate(query) };
  }

  /** not-found 메시지용: 질의를 role 만 남긴(없으면 전체) 완화 질의로 마지막 화면의 관련 노드를 요약한다 */
  async function relatedNodes(query: LocatorQuery): Promise<SemanticNode[]> {
    const relaxed: LocatorQuery = query.role !== undefined ? { role: query.role } : {};
    if (query.within !== undefined) relaxed.within = query.within;
    try { return await engine.locate(relaxed); } catch { return []; }
  }

  /** 기한까지 정확히 하나가 될 때까지 재조회. 0개면 not-found, 2개 이상이면 ambiguous(대기 없음, specs/0002) */
  function resolveOne(spec: LocatorSpec, deadline: number): Promise<SemanticNode> {
    let last: LocatorQuery = spec.query;
    return pollUntil(deadline, async () => {
      const { query, nodes } = await queryNow(spec, deadline);
      last = query;
      if (nodes.length === 1) return nodes[0]!;
      if (nodes.length > 1) {
        throw new EngineError('ambiguous', `${describeQuery(query)} 에 맞는 노드가 ${nodes.length}개: ${summarize(nodes)}. nth/first/testId/exact 로 좁히세요`, { query: spec.query, candidates: nodes.length });
      }
      return undefined;
    }, async (waitedMs) => {
      const related = await relatedNodes(last);
      const hint = related.length > 0 ? ` 마지막 화면의 관련 노드: ${summarize(related)}` : ' 마지막 화면에 관련 노드 없음';
      throw new EngineError('not-found', `${describeQuery(last)} 에 맞는 노드가 없음 (${waitedMs}ms 기다림).${hint}`, { query: spec.query, waitedMs });
    });
  }

  /** 하나로 맞고 비활성이 아닌 노드. 비활성이면 기한까지 활성화를 기다린다 */
  function resolveActionable(spec: LocatorSpec): Promise<SemanticNode> {
    const deadline = Date.now() + timeoutMs;
    let lastNode: SemanticNode | undefined;
    return pollUntil(deadline, async () => {
      const node = await resolveOne(spec, deadline);
      lastNode = node;
      return node.states?.disabled ? undefined : node;
    }, (waitedMs) => {
      throw new EngineError('not-actionable', `${describeQuery(spec.query)} 는 비활성 상태 (${waitedMs}ms 기다림): ${summarize(lastNode ? [lastNode] : [])}`, { query: spec.query, ref: lastNode?.ref, waitedMs });
    });
  }

  function make(spec: LocatorSpec): Locator {
    const act = async (action: NodeAction, arg?: string): Promise<void> => {
      const started = Date.now();
      // secure 노드의 입력값은 스텝 기록에 남기지 않는다
      const instruction = `${action}${arg !== undefined && action !== 'type' ? `(${JSON.stringify(arg)})` : action === 'type' ? '(…)' : ''} ${self.describe()}`;
      try {
        const node = await resolveActionable(spec);
        await engine.perform(node.ref, action, arg);
        options.onStep?.({ kind: 'locator', instruction, durationMs: Date.now() - started });
      } catch (e) {
        options.onStep?.({ kind: 'locator', instruction, durationMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    const read = async (field: 'text' | 'value'): Promise<string | undefined> => {
      const node = await resolveOne(spec, Date.now() + timeoutMs);
      if (node.states?.secure) throw new EngineError('secure-read', `${describeQuery(spec.query)} 는 secure 노드라 ${field} 를 읽을 수 없음`, { query: spec.query, ref: node.ref });
      return node[field];
    };
    const self: Locator = {
      within: (parent) => {
        const parentSpec = specs.get(parent);
        if (!parentSpec) throw new EngineError('not-found', 'within() 에는 같은 screen 이 만든 locator 만 넘길 수 있다');
        return make({ ...spec, parent: parentSpec });
      },
      nth: (index) => make({ ...spec, query: { ...spec.query, nth: index } }),
      first: () => self.nth(0),
      count: async () => (await queryNow(spec, Date.now() + timeoutMs)).nodes.length,
      probe: async (deadline) => {
        try {
          return (await queryNow(spec, deadline ?? Date.now() + timeoutMs)).nodes;
        } catch (e) {
          if (e instanceof EngineError && e.code === 'not-found' && spec.parent) return [];
          throw e;
        }
      },
      isVisible: async () => (await queryNow(spec, Date.now() + timeoutMs)).nodes.length === 1,
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
    specs.set(self, spec);
    return self;
  }

  const withExact = (q: LocatorQuery, o?: TextOptions): LocatorQuery => (o?.exact ? { ...q, exact: true } : q);

  return {
    getByRole: (role, o) => make({ query: withExact(o?.name !== undefined ? { role, name: o.name } : { role }, o) }),
    getByText: (text, o) => make({ query: withExact({ text }, o) }),
    getByTestId: (testId) => make({ query: { testId } }),
    getByPlaceholder: (placeholder) => make({ query: { placeholder } }),
    getByLabel: (label, o) => make({ query: withExact({ name: label }, o) }),
  };
}
