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
