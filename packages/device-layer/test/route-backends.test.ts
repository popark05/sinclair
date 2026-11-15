// 여러 플랫폼 백엔드를 하나로(ios-backend 05): 목록은 합치고, 기기 호출은 그 기기를 가진 백엔드로. 데몬·Studio 가 Android·iOS 를 함께 쓴다.
import { describe, it, expect } from 'vitest';
import { routeBackends } from '../src/route-backends.ts';
import { FakeBackend } from './fake-backend.ts';
import type { DeviceBackend } from '../src/backend.ts';

const ios = (): DeviceBackend & { calls: string[] } => {
  const f = new FakeBackend(['IPHONE1']);
  return Object.assign(Object.create(f), { platform: 'ios' as const, calls: f.calls, listDevices: async () => [{ id: 'IPHONE1', platform: 'ios' as const, model: 'iPhone11,6', osVersion: '17.6.1', state: 'device' as const }], foregroundApp: async () => 'com.apple.Preferences' });
};

describe('routeBackends', () => {
  it('목록은 모든 백엔드를 합치고, 기기 호출은 그 기기의 백엔드로 간다', async () => {
    const a = new FakeBackend(['ANDROID1']);
    const i = ios();
    const r = routeBackends([a, i]);
    expect((await r.listDevices()).map((d) => [d.id, d.platform])).toEqual([['ANDROID1', 'android'], ['IPHONE1', 'ios']]);
    await r.tap('IPHONE1', { x: 1, y: 2 });
    await r.keys('ANDROID1', ['KEYCODE_HOME']);
    expect(i.calls).toEqual(['tap 1,2']);
    expect(a.calls).toEqual(['keys KEYCODE_HOME']);
    expect(await r.foregroundApp!('IPHONE1')).toBe('com.apple.Preferences');
    expect(await r.foregroundApp!('ANDROID1')).toBeUndefined(); // 그 백엔드에 없는 선택 메서드
    expect(await r.screenState!('IPHONE1')).toEqual({});
  });

  it('한 백엔드의 목록이 실패해도 다른 백엔드 기기는 보인다; 모르는 기기는 기기 없음', async () => {
    const broken = new FakeBackend(['X']);
    broken.listDevices = async () => { throw new Error('usbmuxd 없음'); };
    const r = routeBackends([new FakeBackend(['ANDROID1']), broken]);
    expect((await r.listDevices()).map((d) => d.id)).toEqual(['ANDROID1']);
    await expect(r.tap('NOPE', { x: 0, y: 0 })).rejects.toThrow(/기기를 찾을 수 없음/);
  });

  it('목록이 답하지 않는 백엔드는 기한 뒤 빼고(onListTimeout) 나머지 기기는 보인다 — 한 플랫폼이 멈춰도 데몬의 목록이 멈추지 않게', async () => {
    const stuck = new FakeBackend(['X']);
    stuck.listDevices = () => new Promise(() => {});
    const slow: string[] = [];
    const r = routeBackends([new FakeBackend(['ANDROID1']), Object.assign(stuck, { platform: 'ios' as const })], { listTimeoutMs: 100, onListTimeout: (p) => slow.push(p) });
    const t = Date.now();
    expect((await r.listDevices()).map((d) => d.id)).toEqual(['ANDROID1']);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(slow).toEqual(['ios']);
  });
});

