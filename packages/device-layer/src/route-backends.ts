// 여러 플랫폼 백엔드를 하나의 DeviceBackend 로(ios-backend 05): 목록은 합치고(한쪽이 실패해도 나머지는 보인다), 기기 호출은 그 기기를 가진 백엔드로.
// 데몬·Studio 가 디스패처를 거치지 않고 백엔드를 직접 부르는 곳(준비·정리·잠금 확인)에서 Android·iOS 를 가리지 않게 한다.
import type { DeviceBackend, DeviceInfo } from './backend.ts';
import { RpcError, RPC_ERRORS } from './rpc.ts';

export type RoutedBackend = Omit<DeviceBackend, 'platform'> & { readonly platform: DeviceBackend['platform']; readonly backends: readonly DeviceBackend[]; platformOf(deviceId: string): Promise<DeviceBackend['platform']> };

export function routeBackends(backends: readonly DeviceBackend[]): RoutedBackend {
  const list = async (b: DeviceBackend): Promise<DeviceInfo[]> => b.listDevices().catch(() => []);
  const owner = async (id: string): Promise<DeviceBackend> => {
    for (const b of backends) if ((await list(b)).some((d) => d.id === id)) return b;
    throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${id}`);
  };
  return {
    platform: backends[0]?.platform ?? 'android',
    backends,
    async platformOf(id) { return (await owner(id)).platform; },
    async listDevices() { return (await Promise.all(backends.map(list))).flat(); },
    async info(id) { return (await owner(id)).info(id); },
    async screenshot(id) { return (await owner(id)).screenshot(id); },
    async dumpUi(id) { return (await owner(id)).dumpUi(id); },
    async snapshot(id) { return (await owner(id)).snapshot(id); },
    async tap(id, p) { return (await owner(id)).tap(id, p); },
    async longPress(id, p, ms) { return (await owner(id)).longPress(id, p, ms); },
    async swipe(id, a, b, ms) { return (await owner(id)).swipe(id, a, b, ms); },
    async text(id, t) { return (await owner(id)).text(id, t); },
    async keys(id, k) { return (await owner(id)).keys(id, k); },
    async button(id, name) { return (await owner(id)).button(id, name); },
    async keyboardShown(id) { const b = await owner(id); return b.keyboardShown ? b.keyboardShown(id) : undefined; },
    async foregroundApp(id) { const b = await owner(id); return b.foregroundApp ? b.foregroundApp(id) : undefined; },
    async screenState(id) { const b = await owner(id); return b.screenState ? b.screenState(id) : {}; },
    async launchApp(id, a) { return (await owner(id)).launchApp(id, a); },
    async terminateApp(id, a) { return (await owner(id)).terminateApp(id, a); },
    async openUrl(id, u) { return (await owner(id)).openUrl(id, u); },
  };
}
