// 메모리 SemanticNode 트리로 동작하는 Engine. 러너·엔진 테스트의 기준 구현이며 계약 스위트를 통과한다.
import { EngineError, findNodeByRef, locateInTree, NODE_ACTIONS, redactTree, type Engine, type LocatorQuery, type NodeAction, type Observation, type SemanticNode } from '../engine.ts';

export interface FakeEngineOptions {
  root: SemanticNode;
  /** tap 된 노드에 대한 화면 반응. 새 루트를 돌려주면 화면이 바뀐다. */
  onTap?: (node: SemanticNode, engine: FakeEngine) => SemanticNode | void;
}

const clone = <T>(v: T): T => structuredClone(v);

/** FakeEngine 이 지원하는 액션. drag 는 메모리 트리에 의미가 없어 빼며, 그래서 계약 스위트의 unsupported-action 케이스가 실제로 돈다. */
const FAKE_ACTIONS: readonly NodeAction[] = NODE_ACTIONS.filter((a) => a !== 'drag');

export class FakeEngine implements Engine {
  readonly name = 'fake';
  readonly spiVersion = 1;
  readonly actions: readonly NodeAction[] = FAKE_ACTIONS;
  /** 수행된 액션 기록(테스트 검증용). performAt 은 ref 대신 좌표 `@x,y` 로 기록한다. */
  readonly performed: Array<{ ref: string; action: string; arg?: string }> = [];
  readonly typed: string[] = [];
  readonly pressed: string[] = [];
  /** locate 호출 횟수(locator 가 lazy 인지·재조회하는지 검증용). */
  locateCalls = 0;
  private root: SemanticNode;
  private closed = false;
  private sessionTarget: string | undefined;

  constructor(private readonly options: FakeEngineOptions) {
    this.root = clone(options.root);
  }

  /** 화면을 통째로 바꾼다(나중에 나타나는 요소·활성화 같은 시간 의존 시나리오용). */
  setRoot(root: SemanticNode): void {
    this.root = clone(root);
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('engine-closed', 'FakeEngine 은 dispose 됐다');
  }

  /** 지금 보이는 트리. 티켓 03 의 "나중에 나타나는 요소" 시나리오가 필요해지면 여기서 가지치기한다. */
  private visibleRoot(): SemanticNode {
    return this.root;
  }

  async observe(): Promise<Observation> {
    this.assertOpen();
    return { root: redactTree(clone(this.visibleRoot())), ...(this.sessionTarget ? { location: this.sessionTarget } : {}) };
  }

  async locate(query: LocatorQuery): Promise<SemanticNode[]> {
    this.assertOpen();
    this.locateCalls++;
    return locateInTree(this.visibleRoot(), query);
  }

  async perform(ref: string, action: NodeAction, arg?: string): Promise<void> {
    this.assertOpen();
    if (!this.actions.includes(action)) throw new EngineError('unsupported-action', `지원하지 않는 액션: ${action}`);
    // 판정은 "지금 보이는" 트리로, 변경은 원본 트리에. 둘은 ref 로 대응한다.
    const node = findNodeByRef(this.visibleRoot(), ref);
    if (!node) throw new EngineError('not-found', `ref 가 현재 화면에 없음: ${ref}`, { ref });
    if (node.states?.disabled) throw new EngineError('not-actionable', `비활성 노드: ${ref}`, { ref });
    const live = findNodeByRef(this.root, ref)!;
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

  async performAt(x: number, y: number, action: 'tap' | 'long_press' | 'drag_to'): Promise<void> {
    this.assertOpen();
    this.performed.push({ ref: `@${x},${y}`, action });
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
