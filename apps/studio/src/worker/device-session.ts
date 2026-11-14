// 작업 프로세스의 기기 연결(studio 02, ADR 0005): 같은 머신에 살아 있는 데몬이 디바이스 RPC 를 열어 두었으면 거기 붙고(USB 를 다투지 않게),
// 없으면 직접 Android 백엔드와 디바이스 서버를 연다. 둘 다 안 되면 none 과 사유.
import { readDeviceRpc } from '@sinclair/device-layer';
import { rpcOverHttp, type DeviceRpc } from '@sinclair/engine-mobile';
import { appPackageOf } from '@sinclair/agent';
import type { DeviceInfo, SemanticNode } from '@sinclair/protocol';
import type { ConnectionInfo, StudioDevice, StudioKey, StudioSnapshot } from '../shared/studio-ipc.ts';
import type { ForegroundAppResult, SnapshotResult } from '@sinclair/protocol';

export interface OwnDevices { rpc: DeviceRpc; close(): Promise<void> }
export interface ConnectDeps {
  discoveryFile: string;
  /** 데몬이 없을 때 직접 연다 */
  openOwn: () => Promise<OwnDevices>;
  /** 데몬 RPC 가 응답하는지 보는 기한(기본 2초) */
  probeTimeoutMs?: number;
}
export interface DeviceConnection {
  connection: ConnectionInfo;
  rpc?: DeviceRpc;
  listDevices(): Promise<StudioDevice[]>;
  foregroundApp(deviceId: string): Promise<string | null>;
  snapshot(deviceId: string): Promise<StudioSnapshot>;
  tap(deviceId: string, x: number, y: number): Promise<void>;
  swipe(deviceId: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  text(deviceId: string, text: string): Promise<void>;
  key(deviceId: string, key: StudioKey): Promise<void>;
  button(deviceId: string, button: 'back' | 'home'): Promise<void>;
  close(): Promise<void>;
}

const KEYCODES: Record<StudioKey, string> = { enter: 'KEYCODE_ENTER', backspace: 'KEYCODE_DEL', tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT' };
const noDevice = async (): Promise<never> => { throw new Error('기기 연결이 없음'); };

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${ms}ms 안에 응답 없음`)), ms))]);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const toStudioDevice = (d: DeviceInfo): StudioDevice => ({ id: d.id, model: d.model, osVersion: d.osVersion, state: d.state, ...(d.stateDetail ? { stateDetail: d.stateDetail } : {}), ...(d.helper ? { helper: d.helper.state } : {}), ...(d.inUse ? { inUse: true } : {}) });

function over(rpc: DeviceRpc, connection: ConnectionInfo, close: () => Promise<void>): DeviceConnection {
  return {
    connection, rpc, close,
    listDevices: async () => ((await rpc.call('devices.list', {})) as DeviceInfo[]).map(toStudioDevice),
    // 기기에 직접 묻고(화면 트리에 resource-id 가 없는 앱도), 모르거나 구버전 데몬(메서드 없음)이면 화면 트리의 resource-id 패키지로
    foregroundApp: async (deviceId) => {
      const asked = await (rpc.call('device.apps.foreground', { deviceId }) as Promise<ForegroundAppResult>).catch(() => undefined);
      return asked?.appId ?? appPackageOf((await rpc.call('device.dump.ui', { deviceId })) as SemanticNode) ?? null;
    },
    snapshot: async (deviceId) => {
      const s = (await rpc.call('device.snapshot', { deviceId })) as SnapshotResult;
      return { png: s.screenshot.base64, root: s.root, capturedAt: s.capturedAt };
    },
    tap: async (deviceId, x, y) => { await rpc.call('device.io.tap', { deviceId, x, y }); },
    swipe: async (deviceId, a, b, durationMs) => { await rpc.call('device.io.swipe', { deviceId, fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, durationMs }); },
    text: async (deviceId, text) => { await rpc.call('device.io.text', { deviceId, text }); },
    key: async (deviceId, key) => { await rpc.call('device.io.keys', { deviceId, keys: [KEYCODES[key]] }); },
    button: async (deviceId, button) => { await rpc.call('device.io.button', { deviceId, button }); },
  };
}

export async function connectDevices(deps: ConnectDeps): Promise<DeviceConnection> {
  const found = await readDeviceRpc(deps.discoveryFile);
  let daemonProblem = '';
  if (found) {
    const rpc = rpcOverHttp({ port: found.port, token: found.token });
    try {
      await withTimeout(rpc.call('devices.list', {}), deps.probeTimeoutMs ?? 2_000);
      return over(rpc, { mode: 'daemon', detail: `데몬${found.agentId ? ` ${found.agentId}` : ''}(pid ${found.pid})의 디바이스 RPC` }, async () => {});
    } catch (err) { daemonProblem = `데몬 디바이스 RPC 가 응답하지 않음(${errMsg(err)}) — 직접 연다. `; }
  }
  try {
    const own = await deps.openOwn();
    return over(own.rpc, { mode: 'own', detail: `${daemonProblem}작업 프로세스가 직접 연 디바이스 서버` }, () => own.close());
  } catch (err) {
    return { connection: { mode: 'none', detail: `${daemonProblem}기기를 열 수 없음: ${errMsg(err)}` }, listDevices: async () => [], foregroundApp: async () => null, snapshot: noDevice, tap: noDevice, swipe: noDevice, text: noDevice, key: noDevice, button: noDevice, close: async () => {} };
  }
}
