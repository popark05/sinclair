// 디바이스 레이어 JSON-RPC 메서드 이름. OpenRPC 문서는 이 목록에서 생성한다.
// 명명 체계는 mobilecli(FSL)의 설계를 참고했으며 구현은 독자적으로 한다.

export const DEVICE_RPC_METHODS = [
  'devices.list',
  'device.info',
  'device.screenshot',
  'device.screencapture',
  'device.dump.ui',
  'device.io.tap',
  'device.io.longpress',
  'device.io.swipe',
  'device.io.gesture',
  'device.io.text',
  'device.io.keys',
  'device.io.button',
  'device.apps.launch',
  'device.apps.terminate',
  'device.apps.install',
  'device.apps.uninstall',
  'device.apps.clear',
  'device.apps.foreground',
  'device.logs',
  'device.screenrecord',
  'device.clipboard.get',
  'device.clipboard.set',
  'device.url',
  'server.info',
] as const;
export type DeviceRpcMethod = (typeof DEVICE_RPC_METHODS)[number];

export interface JsonRpcRequest<M extends DeviceRpcMethod = DeviceRpcMethod> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

// ---- devices.list / device.info 응답 ----

export const DEVICE_PLATFORMS = ['android', 'ios'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** 디바이스 레이어가 보는 연결 상태. 제어 평면의 Device(idle/leased/…)와는 다른 축이다. */
export const DEVICE_CONNECTION_STATES = ['device', 'unauthorized', 'offline'] as const;
export type DeviceConnectionState = (typeof DEVICE_CONNECTION_STATES)[number];

/** `devices.list` 의 원소이자 `device.info` 의 결과. */
export interface DeviceInfo {
  id: string;
  platform: DevicePlatform;
  model: string;
  osVersion: string;
  state: DeviceConnectionState;
  /** unauthorized/offline 일 때 사용자에게 보여줄 원인 */
  stateDetail?: string;
  /** 기기가 Sinclair CA를 신뢰하는지. 프록시 모드 blocked 판정에 쓴다 */
  caTrusted?: boolean;
}

/** `device.io.*` 의 좌표 */
export interface Point { x: number; y: number }
