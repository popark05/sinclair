// 백엔드들을 디스패처에 연결한다. 메서드 파라미터 검증은 여기서 한다.
import { DEVICE_BUTTONS, type DeviceButton, type Point, type ScreenshotResult } from '@sinclair/protocol';
import type { DeviceBackend } from './backend.ts';
import { RpcDispatcher, RpcError, RPC_ERRORS } from './rpc.ts';

export const SERVER_VERSION = '0.0.0';

export function createDeviceServer(backends: DeviceBackend[]): RpcDispatcher {
  const d = new RpcDispatcher();

  const find = async (deviceId: string): Promise<DeviceBackend> => {
    for (const b of backends) {
      if ((await b.listDevices()).some((x) => x.id === deviceId)) return b;
    }
    throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${deviceId}`);
  };
  const str = (p: Record<string, unknown>, k: string): string => {
    const v = p[k];
    if (typeof v !== 'string' || v === '') throw new RpcError(RPC_ERRORS.invalidParams, `${k} 가 필요합니다`);
    return v;
  };
  const num = (p: Record<string, unknown>, k: string, dflt?: number): number => {
    const v = p[k];
    if (typeof v === 'number') return v;
    if (dflt !== undefined) return dflt;
    throw new RpcError(RPC_ERRORS.invalidParams, `${k} 가 필요합니다`);
  };
  // 좌표 키: 접두사가 없으면 x/y, 있으면 fromX/fromY 처럼 camelCase (durationMs 와 같은 규칙).
  const point = (p: Record<string, unknown>, prefix = ''): Point => ({ x: num(p, prefix ? `${prefix}X` : 'x'), y: num(p, prefix ? `${prefix}Y` : 'y') });

  d.register('server.info', async () => ({ version: SERVER_VERSION, platforms: backends.map((b) => b.platform) }));
  d.register('devices.list', async () => (await Promise.all(backends.map((b) => b.listDevices()))).flat());
  d.register('device.info', async (p) => (await find(str(p, 'deviceId'))).info(str(p, 'deviceId')));
  d.register('device.screenshot', async (p) => {
    const id = str(p, 'deviceId');
    const result: ScreenshotResult = { format: 'png', base64: Buffer.from(await (await find(id)).screenshot(id)).toString('base64') };
    return result;
  });
  d.register('device.dump.ui', async (p) => { const id = str(p, 'deviceId'); return (await find(id)).dumpUi(id); });
  d.register('device.snapshot', async (p) => { const id = str(p, 'deviceId'); return (await find(id)).snapshot(id); });
  d.register('device.io.tap', async (p) => { const id = str(p, 'deviceId'); await (await find(id)).tap(id, point(p)); return null; });
  d.register('device.io.longpress', async (p) => { const id = str(p, 'deviceId'); await (await find(id)).longPress(id, point(p), num(p, 'durationMs', 800)); return null; });
  d.register('device.io.swipe', async (p) => {
    const id = str(p, 'deviceId');
    await (await find(id)).swipe(id, point(p, 'from'), point(p, 'to'), num(p, 'durationMs', 300));
    return null;
  });
  d.register('device.io.text', async (p) => { const id = str(p, 'deviceId'); await (await find(id)).text(id, str(p, 'text')); return null; });
  d.register('device.io.keys', async (p) => {
    const id = str(p, 'deviceId');
    const keys = p['keys'];
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) throw new RpcError(RPC_ERRORS.invalidParams, 'keys 는 문자열 배열이어야 합니다');
    await (await find(id)).keys(id, keys as string[]);
    return null;
  });
  d.register('device.io.button', async (p) => {
    const id = str(p, 'deviceId');
    const button = str(p, 'button');
    if (!(DEVICE_BUTTONS as readonly string[]).includes(button)) throw new RpcError(RPC_ERRORS.invalidParams, `button 은 ${DEVICE_BUTTONS.join('|')} 중 하나여야 합니다`);
    await (await find(id)).button(id, button as DeviceButton);
    return null;
  });
  d.register('device.io.keyboard', async (p) => {
    const id = str(p, 'deviceId');
    const b = await find(id);
    const shown = b.keyboardShown ? await b.keyboardShown(id) : undefined;
    return { shown: shown ?? null };
  });
  d.register('device.apps.launch', async (p) => { const id = str(p, 'deviceId'); await (await find(id)).launchApp(id, str(p, 'appId')); return null; });
  d.register('device.apps.terminate', async (p) => { const id = str(p, 'deviceId'); await (await find(id)).terminateApp(id, str(p, 'appId')); return null; });
  d.register('device.url', async (p) => { const id = str(p, 'deviceId'); await (await find(id)).openUrl(id, str(p, 'url')); return null; });

  return d;
}
