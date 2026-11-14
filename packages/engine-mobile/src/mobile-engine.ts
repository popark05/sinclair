// 러너 Engine 계약의 모바일 구현. 디바이스 레이어 JSON-RPC(device.dump.ui/snapshot/io.*/apps.*)만 쓴다.
// 설계: specs/0002-engine-contract.md, 티켓 .scratch/runner-locator/issues/02-*.md
import {
  EngineError, findNodeByRef, locateInTree, NODE_ACTIONS, redactTree,
  type DeviceButton, type Engine, type LocatorQuery, type NodeAction, type Observation, type ObserveOptions, type SemanticNode, type SnapshotResult,
} from '@sinclair/protocol';
import { RPC_ERRORS } from '@sinclair/device-layer';
import { DeviceRpcError, type DeviceRpc } from './rpc.ts';

export interface MobileEngineOptions {
  deviceId: string;
  /** session.open/restart 가 실행할 앱. 없으면 session.open 은 홈으로 간다 */
  appId?: string;
  /** 노드 rect 가 두 번 연속 같아질 때까지 기다리는 상한(ms). 전환·스크롤 애니메이션은 보통 300~500ms */
  stabilityTimeoutMs?: number;
  /** 안정화 재확인 간격(ms) */
  stabilityPollMs?: number;
  /** 화면을 바꿀 수 있는 액션(탭·키·스크롤·뒤로) 뒤 트리가 바뀌기를 기다리는 상한(ms). 안 바뀌는 액션은 이만큼 늦어진다. 0 이면 기다리지 않는다 */
  settleChangeMs?: number;
  /** 앱 실행(session.open·restart) 뒤 화면이 잠잠해지기를 기다리는 전체 상한(ms). 스플래시·로딩을 지나 첫 화면까지. 0 이면 기다리지 않는다 */
  launchSettleMs?: number;
  /** 롱프레스·스와이프 기본 시간(ms). Android 롱프레스 기준 500ms 보다 넉넉히 */
  longPressMs?: number;
  swipeMs?: number;
}

const DEFAULT_STABILITY_TIMEOUT_MS = 2_000;
const DEFAULT_STABILITY_POLL_MS = 100;
/** 실기기 화면 전환은 탭 뒤 보통 100~300ms 안에 트리에 나타난다. 그보다 넉넉히 */
const DEFAULT_SETTLE_CHANGE_MS = 1_000;
/** 앱 실행: 콜드 스타트는 수 초가 걸린다. 상한을 넘으면 그때 화면으로 넘어간다(실패 아님) */
const DEFAULT_LAUNCH_SETTLE_MS = 8_000;
/** 앱 실행: 다른 화면에서 띄우면 보통 300ms 안에 바뀐다. 이만큼 안 바뀌면 이미 떠 있던 앱으로 본다 */
const LAUNCH_CHANGE_MS = 1_500;
/** 앱 실행: 스플래시가 잠깐 멈춰 있다가 바뀌기도 해서, 이만큼 안 바뀌어야 다 떴다고 본다 */
const LAUNCH_QUIET_MS = 500;
const DEFAULT_LONG_PRESS_MS = 800;
/** 스와이프 한 번의 시간. 너무 빠르면 플링(관성)으로, 너무 느리면 드래그로 해석된다. adb shell input swipe 의 관례값 */
const DEFAULT_SWIPE_MS = 300;
/** 스크롤 한 번에 움직이는 비율(노드 높이·너비 기준). 가장자리 관성을 피하려고 40%씩 */
const SCROLL_FRACTION = 0.4;

/** 이 엔진이 지원하는 액션. drag/select 는 디바이스 RPC 에 대응이 없다 */
const MOBILE_ACTIONS: readonly NodeAction[] = NODE_ACTIONS.filter((a) => a !== 'drag' && a !== 'select');
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const CHECKABLE_ROLES = new Set(['checkbox', 'switch', 'radio']);

/** press 의 키 이름 → Android 키코드. 그 외는 KEYCODE_ 접두사를 붙여 그대로 보낸다 */
const KEY_CODES: Record<string, string> = {
  Enter: 'KEYCODE_ENTER', Back: 'KEYCODE_BACK', Tab: 'KEYCODE_TAB', Escape: 'KEYCODE_ESCAPE', Delete: 'KEYCODE_DEL',
  Backspace: 'KEYCODE_DEL', Home: 'KEYCODE_HOME', Space: 'KEYCODE_SPACE', ArrowUp: 'KEYCODE_DPAD_UP', ArrowDown: 'KEYCODE_DPAD_DOWN',
  ArrowLeft: 'KEYCODE_DPAD_LEFT', ArrowRight: 'KEYCODE_DPAD_RIGHT',
};

/** ref 가 dump 마다 바뀌어도 같은 노드를 다시 찾기 위한 기술자 */
interface Descriptor { role: string; testId?: string; name?: string; text?: string; placeholder?: string }

function describe(n: SemanticNode): Descriptor {
  return {
    role: n.role,
    ...(n.testId !== undefined ? { testId: n.testId } : {}),
    ...(n.name !== undefined ? { name: n.name } : {}),
    ...(n.text !== undefined ? { text: n.text } : {}),
    ...(n.placeholder !== undefined ? { placeholder: n.placeholder } : {}),
  };
}

/** 화면을 차지한 앱: 노드 testId(resource-id `패키지:id/이름`)의 패키지 중 가장 많은 것. 모르면 undefined */
function foregroundPackage(root: SemanticNode): string | undefined {
  const count = new Map<string, number>();
  forEachNode(root, (n) => { const m = /^([\w.]+):id\//.exec(n.testId ?? ''); if (m) count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1); });
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** 화면 정체 비교용: 노드마다 역할·이름·testId(문서 순서). 글자·값·rect 는 넣지 않는다(시계·카운트다운·애니메이션) */
function screenSignature(root: SemanticNode): string {
  const parts: string[] = [];
  forEachNode(root, (n) => { parts.push(`${n.role}|${n.name ?? ''}|${n.testId ?? ''}`); });
  return parts.join('\n');
}

function sameDescriptor(a: Descriptor, b: Descriptor): boolean {
  return a.role === b.role && a.testId === b.testId && a.name === b.name && a.text === b.text && a.placeholder === b.placeholder;
}

function sameRect(a: SemanticNode['rect'], b: SemanticNode['rect']): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function forEachNode(root: SemanticNode, visit: (n: SemanticNode) => void): void {
  visit(root);
  for (const c of root.children ?? []) forEachNode(c, visit);
}

/** scroll 방향 → 손가락 이동 벡터(내용이 그 방향으로 드러나도록 반대로 스와이프) */
const SCROLL_VECTORS: Record<string, { dx: number; dy: number }> = {
  down: { dx: 0, dy: -1 }, up: { dx: 0, dy: 1 }, left: { dx: 1, dy: 0 }, right: { dx: -1, dy: 0 },
};

function center(n: SemanticNode): { x: number; y: number } {
  const r = n.rect;
  if (!r || r.width <= 0 || r.height <= 0) throw new EngineError('not-actionable', `화면 위치가 없는 노드: ${n.ref}`, { ref: n.ref });
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

export function createMobileEngine(rpc: DeviceRpc, options: MobileEngineOptions): Engine {
  const { deviceId } = options;
  const stabilityTimeoutMs = options.stabilityTimeoutMs ?? DEFAULT_STABILITY_TIMEOUT_MS;
  const stabilityPollMs = options.stabilityPollMs ?? DEFAULT_STABILITY_POLL_MS;
  const settleChangeMs = options.settleChangeMs ?? DEFAULT_SETTLE_CHANGE_MS;
  const launchSettleMs = options.launchSettleMs ?? DEFAULT_LAUNCH_SETTLE_MS;
  const longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const swipeMs = options.swipeMs ?? DEFAULT_SWIPE_MS;
  const descriptors = new Map<string, Descriptor>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new EngineError('engine-closed', `엔진이 dispose 됐다(${deviceId})`);
  }

  /** 디바이스 레이어 오류 → EngineError. 기기·헬퍼 문제는 device-unavailable, 파라미터 거부(비ASCII 등)는 not-actionable */
  async function call<M extends Parameters<DeviceRpc['call']>[0]>(method: M, params: Parameters<DeviceRpc['call']>[1]): Promise<unknown> {
    try {
      return await rpc.call(method, params as never);
    } catch (e) {
      if (e instanceof DeviceRpcError) {
        if (e.code === RPC_ERRORS.deviceNotFound || e.code === RPC_ERRORS.helperUnavailable) {
          throw new EngineError('device-unavailable', `기기 ${deviceId}: ${e.message}`, { method, rpcCode: e.code });
        }
        if (e.code === RPC_ERRORS.invalidParams) throw new EngineError('not-actionable', `기기 ${deviceId}: ${e.message}`, { method, rpcCode: e.code });
        throw new EngineError('device-error', `기기 ${deviceId}: ${method} 실패: ${e.message}`, { method, rpcCode: e.code });
      }
      throw e;
    }
  }

  /**
   * dump 의 ref → 기술자. 지우지 않고 덮어쓴다: locate 와 perform 사이에 다른 dump 가 끼어도(같은 호출자의 자동 대기 등)
   * 이전 ref 의 기술자가 남아 재매핑된다. ref 는 DFS 번호라 덮어쓰기로 크기가 유지된다. 엔진은 한 번에 한 호출자만 전제한다.
   */
  function remember(root: SemanticNode): void {
    forEachNode(root, (n) => descriptors.set(n.ref, describe(n)));
  }

  /** 가장 최근 dump. 액션 뒤 화면 변화를 잴 기준이 된다 */
  let lastRoot: SemanticNode | undefined;

  async function dump(): Promise<SemanticNode> {
    const root = (await call('device.dump.ui', { deviceId })) as SemanticNode;
    remember(root);
    lastRoot = root;
    return root;
  }

  /**
   * 화면을 바꿀 수 있는 액션 뒤: 트리가 액션 전과 달라질 때까지(상한 changeMs), 달라졌으면 quietMs 동안 더 바뀌지 않을 때까지(전체 상한 totalMs) 기다린다.
   * 실기기는 탭 직후 관찰에 옛 화면이 보여 에이전트가 같은 탭을 반복했고, 앱 실행 직후 관찰에는 곧 사라질 실행 중 화면이 보였다.
   * 비교는 노드의 역할·이름·testId 만 — 재생 시간·광고 카운트다운 같은 글자, 애니메이션 rect 는 보지 않는다(그것 때문에 상한까지 기다리지 않게).
   * 상한에 닿아도 실패가 아니다.
   */
  async function settleAfter(before: SemanticNode | undefined, limits = { changeMs: settleChangeMs, totalMs: stabilityTimeoutMs, quietMs: 0 }): Promise<void> {
    if (!before || limits.changeMs <= 0 || limits.totalMs <= 0) return;
    const start = Date.now();
    let prev = screenSignature(before);
    let changed = false;
    let lastChange = start;
    while (Date.now() - start < limits.totalMs) {
      await new Promise((r) => setTimeout(r, stabilityPollMs));
      const sig = screenSignature(await dump());
      if (sig !== prev) { changed = true; prev = sig; lastChange = Date.now(); continue; }
      if (!changed) { if (Date.now() - start >= limits.changeMs) return; continue; }
      if (Date.now() - lastChange >= limits.quietMs) return; // 바뀐 뒤 한 번 이상 같은 화면 + 조용한 시간
    }
  }

  /** 앱 실행 뒤: 스플래시·로딩을 지나 잠잠해질 때까지 */
  const settleLaunch = (before: SemanticNode) => settleAfter(before, { changeMs: Math.min(LAUNCH_CHANGE_MS, launchSettleMs), totalMs: launchSettleMs, quietMs: LAUNCH_QUIET_MS });

  /** 새 dump 에서 ref 의 노드를 찾는다. 같은 ref 가 같은 기술자를 가리키면 그것, 아니면 기술자로 재탐색 */
  function resolveIn(root: SemanticNode, ref: string, desc: Descriptor | undefined): SemanticNode | undefined {
    const direct = findNodeByRef(root, ref);
    if (!desc) return direct;
    if (direct && sameDescriptor(describe(direct), desc)) return direct;
    // 같은 기술자의 노드가 여럿이면(같은 문구의 행 등) 문서 순서 첫 노드를 고른다. 호출자는 testId 나 within 으로 좁혀야 한다.
    let found: SemanticNode | undefined;
    forEachNode(root, (n) => { if (!found && sameDescriptor(describe(n), desc)) found = n; });
    return found;
  }

  /** ref 를 현재 화면에서 다시 찾고, 좌표 액션이면 rect 가 두 번 연속 같을 때까지 기다린다 */
  async function resolveStable(ref: string, needsStableRect: boolean): Promise<SemanticNode> {
    const desc = descriptors.get(ref);
    const deadline = Date.now() + stabilityTimeoutMs;
    let previous: SemanticNode | undefined;
    for (;;) {
      const node = resolveIn(await dump(), ref, desc);
      if (!node) throw new EngineError('not-found', `현재 화면에 없는 노드: ${ref}`, { ref, descriptor: desc });
      if (!needsStableRect) return node;
      if (previous && sameRect(previous.rect, node.rect)) return node;
      if (Date.now() >= deadline) throw new EngineError('not-actionable', `노드가 계속 움직인다(${stabilityTimeoutMs}ms): ${ref}`, { ref, rect: node.rect });
      previous = node;
      await new Promise((r) => setTimeout(r, stabilityPollMs));
    }
  }

  /**
   * 입력이 트리에 보일 때까지(상한 stabilityTimeoutMs) 기다린다. 실기기(YouTube 검색창)는 입력 뒤 약 200ms 동안 값이 비어 보여,
   * 곧바로 관찰한 호출자(에이전트)가 빈 칸으로 알고 다시 입력했다. 끝내 안 보여도(앱이 글자를 바꾸거나 가림) 실패로 보지 않는다 —
   * 입력 자체는 성공했고, 판단은 다음 관찰을 보는 호출자 몫이다. secure 칸은 값이 나오지 않으니 기다리지 않는다.
   */
  async function settleTyped(ref: string, before: SemanticNode, text: string): Promise<void> {
    if (!text || before.states?.secure) return;
    const desc = descriptors.get(ref);
    const prior = before.value ?? '';
    const deadline = Date.now() + stabilityTimeoutMs;
    while (Date.now() < deadline) {
      const now = resolveIn(await dump(), ref, desc);
      const v = now?.value ?? '';
      if (v.length > prior.length && v.includes(text)) return;
      await new Promise((r) => setTimeout(r, stabilityPollMs));
    }
  }

  const tapAt = (p: { x: number; y: number }) => call('device.io.tap', { deviceId, x: p.x, y: p.y });
  const longPressAt = (p: { x: number; y: number }) => call('device.io.longpress', { deviceId, x: p.x, y: p.y, durationMs: longPressMs });
  const swipeBetween = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    call('device.io.swipe', { deviceId, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: swipeMs });
  const keys = (names: string[]) => call('device.io.keys', { deviceId, keys: names });
  const button = (name: DeviceButton) => call('device.io.button', { deviceId, button: name });
  /** 키 이름 표에 있거나 KEYCODE_ 로 시작하는 것만 받는다. 오타를 기기 레이어까지 보내지 않는다 */
  const keyCode = (key: string): string => {
    const code = KEY_CODES[key] ?? (key.startsWith('KEYCODE_') ? key : undefined);
    if (!code) throw new EngineError('unsupported-action', `알 수 없는 키: ${key} (${Object.keys(KEY_CODES).join(', ')} 또는 KEYCODE_*)`, { key });
    return code;
  };

  const engine: Engine = {
    name: 'mobile',
    spiVersion: 1,
    actions: MOBILE_ACTIONS,

    async observe(opts?: ObserveOptions): Promise<Observation> {
      assertOpen();
      if (!opts?.pixels) return { root: redactTree(await dump()) };
      const snap = (await call('device.snapshot', { deviceId })) as SnapshotResult;
      remember(snap.root);
      return { root: redactTree(snap.root), pixels: Buffer.from(snap.screenshot.base64, 'base64'), atomic: snap.atomic };
    },

    async locate(query: LocatorQuery): Promise<SemanticNode[]> {
      assertOpen();
      return locateInTree(await dump(), query);
    },

    async perform(ref: string, action: NodeAction, arg?: string): Promise<void> {
      assertOpen();
      if (!MOBILE_ACTIONS.includes(action)) throw new EngineError('unsupported-action', `engine-mobile 은 ${action} 을 지원하지 않는다`, { action });
      const node = await resolveStable(ref, action !== 'press');
      if (node.states?.disabled) throw new EngineError('not-actionable', `비활성 노드: ${ref}`, { ref });
      switch (action) {
        case 'tap': { const before = lastRoot; await tapAt(center(node)); await settleAfter(before); return; }
        case 'double_tap': { const before = lastRoot; const p = center(node); await tapAt(p); await tapAt(p); await settleAfter(before); return; }
        case 'long_press': { const before = lastRoot; await longPressAt(center(node)); await settleAfter(before); return; }
        case 'type': {
          if (!EDITABLE_ROLES.has(node.role)) throw new EngineError('not-actionable', `편집할 수 없는 노드: ${ref} (${node.role})`, { ref });
          await tapAt(center(node)); // 포커스
          await call('device.io.text', { deviceId, text: arg ?? '' });
          await settleTyped(ref, node, arg ?? '');
          return;
        }
        case 'check': {
          if (!CHECKABLE_ROLES.has(node.role)) throw new EngineError('not-actionable', `체크할 수 없는 노드: ${ref} (${node.role})`, { ref });
          await tapAt(center(node));
          return;
        }
        case 'press': { const before = lastRoot; await keys([keyCode(arg ?? 'Enter')]); await settleAfter(before); return; }
        case 'scroll':
        case 'scroll_to': {
          const r = node.rect!;
          const c = center(node);
          const v = SCROLL_VECTORS[arg ?? 'down'];
          if (!v) throw new EngineError('not-actionable', `scroll 방향은 up/down/left/right 중 하나: ${arg}`, { ref, arg });
          const dx = Math.round(r.width * SCROLL_FRACTION) * v.dx, dy = Math.round(r.height * SCROLL_FRACTION) * v.dy;
          const before = lastRoot;
          await swipeBetween({ x: c.x - dx, y: c.y - dy }, { x: c.x + dx, y: c.y + dy });
          await settleAfter(before);
          return;
        }
        default:
          throw new EngineError('unsupported-action', `engine-mobile 은 ${action} 을 지원하지 않는다`, { action });
      }
    },

    async performAt(x, y, action, to) {
      assertOpen();
      if (action === 'tap') await tapAt({ x, y });
      else if (action === 'long_press') await longPressAt({ x, y });
      else {
        if (!to) throw new EngineError('not-actionable', 'drag_to 에는 목적지 좌표가 필요하다');
        await swipeBetween({ x, y }, to);
      }
    },

    keyboard: {
      type: async (text) => { assertOpen(); await call('device.io.text', { deviceId, text }); },
      press: async (key) => { assertOpen(); await keys([keyCode(key)]); },
      dismiss: async () => { assertOpen(); await button('back'); },
      // 모르면(null) false: dismiss 가 뒤로 버튼이라 키보드가 없는데 누르면 화면을 떠난다
      shown: async () => { assertOpen(); const r = (await call('device.io.keyboard', { deviceId })) as { shown: boolean | null }; return r.shown === true; },
    },

    session: {
      open: async (target) => {
        assertOpen();
        const appId = target ?? options.appId;
        const before = await dump();
        // 이미 그 앱이 화면을 차지하고 있으면 실행해도 화면이 안 바뀐다: 변화 대기 상한만큼 늦어지지 않게 건너뛴다
        if (appId) { await call('device.apps.launch', { deviceId, appId }); if (foregroundPackage(before) !== appId) await settleLaunch(before); }
        else { await button('home'); await settleAfter(before); }
      },
      back: async () => { assertOpen(); const before = await dump(); await button('back'); await settleAfter(before); },
      restart: async (target) => {
        assertOpen();
        const appId = target ?? options.appId;
        if (!appId) throw new EngineError('unsupported-action', 'restart 에는 appId 가 필요하다');
        await call('device.apps.terminate', { deviceId, appId });
        const before = await dump(); // 종료 뒤 화면(런처 등)을 기준으로: 다시 띄운 앱이 종료 전 화면과 같아도 변화를 놓치지 않는다
        await call('device.apps.launch', { deviceId, appId });
        await settleLaunch(before);
      },
      reset: async () => {
        assertOpen();
        throw new EngineError('unsupported-action', 'reset(앱 데이터 삭제)은 범위 밖이다. 필요하면 device.apps.clear 가 구현된 뒤 연결한다');
      },
    },

    async dispose() {
      closed = true;
    },
  };
  return engine;
}
