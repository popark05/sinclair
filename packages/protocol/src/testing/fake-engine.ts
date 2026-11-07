// 메모리 SemanticNode 트리로 동작하는 Engine. 러너·엔진 테스트의 기준 구현이며 계약 스위트를 통과한다.
import { EngineError, locateInTree, NODE_ACTIONS, type Engine, type LocatorQuery, type NodeAction, type Observation, type SemanticNode } from '../engine.ts';

export interface FakeEngineOptions {
  root: SemanticNode;
  /** tap 된 노드에 대한 화면 반응. 새 루트를 돌려주면 화면이 바뀐다. */
  onTap?: (node: SemanticNode, engine: FakeEngine) => SemanticNode | void;
  /** 노드를 찾을 때 적용되는 지연(ms). "나중에 나타나는 요소" 시나리오용. */
  appearAfterMs?: Record<string, number>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function findMutable(root: SemanticNode, ref: string): SemanticNode | undefined {
  if (root.ref === ref) return root;
  for (const c of root.children ?? []) {
    const f = findMutable(c, ref);
    if (f) return f;
  }
  return undefined;
}

/** observe 는 secure 노드의 내용을 주지 않는다(계약). */
function redactTree(node: SemanticNode): SemanticNode {
  const { children, ...rest } = node;
  const base = rest.states?.secure ? (({ text: _t, value: _v, ...r }) => r)(rest) : rest;
  return children ? { ...base, children: children.map(redactTree) } : base;
}

export class FakeEngine implements Engine {
  readonly name = 'fake';
  readonly spiVersion = 1;
  readonly actions: readonly NodeAction[] = NODE_ACTIONS;
  /** 수행된 액션 기록(테스트 검증용). */
  readonly performed: Array<{ ref: string; action: NodeAction; arg?: string }> = [];
  readonly typed: string[] = [];
  readonly pressed: string[] = [];
  private root: SemanticNode;
  private closed = false;
  private readonly startedAt = Date.now();
  private sessionTarget: string | undefined;

  constructor(private readonly options: FakeEngineOptions) {
    this.root = clone(options.root);
  }

  /** 화면을 통째로 바꾼다(앱 전환 시뮬레이션). */
  setRoot(root: SemanticNode): void {
    this.root = clone(root);
  }

  /** 현재 화면의 노드를 테스트에서 직접 고친다. */
  mutate(ref: string, patch: Partial<SemanticNode>): void {
    const n = findMutable(this.root, ref);
    if (!n) throw new Error(`FakeEngine: ${ref} 없음`);
    Object.assign(n, patch);
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('engine-closed', 'FakeEngine 은 dispose 됐다');
  }

  private visibleRoot(): SemanticNode {
    const delays = this.options.appearAfterMs;
    if (!delays) return this.root;
    const elapsed = Date.now() - this.startedAt;
    const prune = (n: SemanticNode): SemanticNode | undefined => {
      if ((delays[n.ref] ?? 0) > elapsed) return undefined;
      const children = n.children?.map(prune).filter((c): c is SemanticNode => c !== undefined);
      return children ? { ...n, children } : n;
    };
    return prune(this.root) ?? { ref: this.root.ref, role: this.root.role };
  }

  async observe(): Promise<Observation> {
    this.assertOpen();
    return { root: redactTree(clone(this.visibleRoot())), ...(this.sessionTarget ? { location: this.sessionTarget } : {}) };
  }

  async locate(query: LocatorQuery): Promise<SemanticNode[]> {
    this.assertOpen();
    return locateInTree(this.visibleRoot(), query);
  }

  async perform(ref: string, action: NodeAction, arg?: string): Promise<void> {
    this.assertOpen();
    if (!this.actions.includes(action)) throw new EngineError('unsupported-action', `지원하지 않는 액션: ${action}`);
    const node = findMutable(this.visibleRoot(), ref);
    if (!node) throw new EngineError('not-found', `ref 가 현재 화면에 없음: ${ref}`, { ref });
    if (node.states?.disabled) throw new EngineError('not-actionable', `비활성 노드: ${ref}`, { ref });
    const live = findMutable(this.root, ref)!;
    this.performed.push(arg === undefined ? { ref, action } : { ref, action, arg });
    switch (action) {
      case 'type': {
        if (!['textbox', 'searchbox', 'combobox'].includes(node.role)) throw new EngineError('not-actionable', `편집할 수 없는 노드: ${ref} (${node.role})`, { ref });
        live.value = (live.value ?? '') + (arg ?? '');
        return;
      }
      case 'check': {
        if (!['checkbox', 'switch', 'radio'].includes(node.role)) throw new EngineError('not-actionable', `체크할 수 없는 노드: ${ref} (${node.role})`, { ref });
        live.states = { ...live.states, checked: !live.states?.checked };
        return;
      }
      case 'select': {
        if (node.role !== 'combobox') throw new EngineError('not-actionable', `선택할 수 없는 노드: ${ref} (${node.role})`, { ref });
        if (arg === undefined) delete live.value; else live.value = arg;
        return;
      }
      case 'tap':
      case 'double_tap':
      case 'long_press': {
        const next = this.options.onTap?.(clone(live), this);
        if (next) this.root = clone(next);
        return;
      }
      default:
        return; // press/drag/scroll/scroll_to: 화면 변화 없음
    }
  }

  async performAt(): Promise<void> {
    this.assertOpen();
  }

  readonly keyboard = {
    type: async (text: string): Promise<void> => { this.assertOpen(); this.typed.push(text); },
    press: async (key: string): Promise<void> => { this.assertOpen(); this.pressed.push(key); },
    dismiss: async (): Promise<void> => { this.assertOpen(); },
  };

  readonly session = {
    open: async (target?: string): Promise<void> => { this.assertOpen(); this.sessionTarget = target; this.root = clone(this.options.root); },
    back: async (): Promise<void> => { this.assertOpen(); this.root = clone(this.options.root); },
    restart: async (): Promise<void> => { this.assertOpen(); this.root = clone(this.options.root); },
    reset: async (): Promise<void> => { this.assertOpen(); this.root = clone(this.options.root); },
  };

  async dispose(): Promise<void> {
    this.closed = true;
  }
}
