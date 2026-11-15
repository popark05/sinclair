// @vitest-environment node
// Studio 작업 프로세스의 기기 연결(studio 02, ADR 0005): 살아 있는 데몬의 디바이스 RPC 가 있으면 거기 붙고, 없으면 직접 연다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDeviceServer, publishDeviceRpc, serveHttp, type DeviceBackend } from '@sinclair/device-layer';
import { rpcOverDispatcher } from '@sinclair/engine-mobile';
import { connectDevices } from '../src/worker/device-session.ts';

const fakeBackend = (id: string, model: string): DeviceBackend => ({
  platform: 'android',
  listDevices: async () => [{ id, platform: 'android', model, osVersion: '13', state: 'device', helper: { state: 'ready', version: '0.1.0' } }],
  info: async () => ({ id, platform: 'android', model, osVersion: '13', state: 'device', helper: { state: 'ready', version: '0.1.0' } }),
}) as unknown as DeviceBackend;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-studio-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('기기 조작(studio 03)', () => {
  it('스냅샷은 스크린샷(base64 PNG)과 트리, 입력은 디바이스 RPC 로(키 이름은 KEYCODE 로)', async () => {
    const calls: string[] = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const backend = {
      ...fakeBackend('OWN0000002', 'Pixel 7'),
      snapshot: async () => ({ screenshot: { format: 'png', base64: png }, root: { ref: '@e0', role: 'root' }, atomic: true, capturedAt: '2026-11-14T00:00:00.000Z' }),
      tap: async (_: string, p: { x: number; y: number }) => { calls.push(`tap ${p.x},${p.y}`); },
      swipe: async (_: string, a: { x: number; y: number }, b: { x: number; y: number }, d: number) => { calls.push(`swipe ${a.x},${a.y}->${b.x},${b.y} ${d}`); },
      text: async (_: string, t: string) => { calls.push(`text ${t}`); },
      keys: async (_: string, k: string[]) => { calls.push(`keys ${k.join('+')}`); },
      button: async (_: string, b: string) => { calls.push(`button ${b}`); },
    } as unknown as DeviceBackend;
    const c = await connectDevices({ discoveryFile: path.join(dir, 'none.json'), openOwn: async () => ({ rpc: rpcOverDispatcher(createDeviceServer([backend])), close: async () => {} }) });
    expect(await c.snapshot('OWN0000002')).toEqual({ png, root: { ref: '@e0', role: 'root' }, capturedAt: '2026-11-14T00:00:00.000Z' });
    await c.tap('OWN0000002', 10, 20);
    await c.swipe('OWN0000002', { x: 1, y: 2 }, { x: 3, y: 4 }, 300);
    await c.text('OWN0000002', 'abc');
    await c.key('OWN0000002', 'enter');
    await c.key('OWN0000002', 'backspace');
    await c.button('OWN0000002', 'back');
    expect(calls).toEqual(['tap 10,20', 'swipe 1,2->3,4 300', 'text abc', 'keys KEYCODE_ENTER', 'keys KEYCODE_DEL', 'button back']);
  });
});

describe('현재 앱', () => {
  const open = (backend: DeviceBackend) => connectDevices({ discoveryFile: path.join(dir, 'none.json'), openOwn: async () => ({ rpc: rpcOverDispatcher(createDeviceServer([backend])), close: async () => {} }) });
  it('기기가 알려 주는 앞 화면 앱을 쓴다(화면 트리에 resource-id 가 없는 지도 앱도)', async () => {
    const c = await open({ ...fakeBackend('OWN0000002', 'Pixel 7'), foregroundApp: async () => 'com.google.android.apps.maps', dumpUi: async () => ({ ref: '@e0', role: 'root' }) } as unknown as DeviceBackend);
    expect(await c.foregroundApp('OWN0000002')).toBe('com.google.android.apps.maps');
  });
  it('홈 화면(런처)은 앱이 아니다 — 기기가 런처를 알려 줘도 null(실기: 홈에서 현재 앱 → com.sec.android.app.launcher 가 세션·내보내기·Cycle 의 앱이 돼 monkey 실행 실패)', async () => {
    const c = await open({ ...fakeBackend('OWN0000002', 'SM-N981N'), foregroundApp: async () => 'com.sec.android.app.launcher', dumpUi: async () => ({ ref: '@e0', role: 'root', children: [{ ref: '@e1', role: 'button', testId: 'com.sec.android.app.launcher:id/icon' }] }) } as unknown as DeviceBackend);
    expect(await c.foregroundApp('OWN0000002')).toBeNull();
  });
  it('기기 목록에 플랫폼을 싣는다(툴바가 플랫폼이 바뀐 기기 전환을 안다)', async () => {
    const c = await open(fakeBackend('OWN0000002', 'Pixel 7'));
    expect(await c.listDevices()).toEqual([expect.objectContaining({ id: 'OWN0000002', platform: 'android' })]);
  });
  it('기기 목록에 inUse(Run 이 쓰는 중)를 싣는다', async () => {
    const c = await open({ ...fakeBackend('OWN0000002', 'Pixel 7'), listDevices: async () => [{ id: 'OWN0000002', platform: 'android', model: 'Pixel 7', osVersion: '13', state: 'device', inUse: true }] } as unknown as DeviceBackend);
    expect(await c.listDevices()).toEqual([expect.objectContaining({ id: 'OWN0000002', inUse: true })]);
  });

  it('기기가 모르면(구버전 데몬 포함) 화면 트리의 resource-id 패키지로', async () => {
    const c = await open({ ...fakeBackend('OWN0000002', 'Pixel 7'), dumpUi: async () => ({ ref: '@e0', role: 'root', children: [{ ref: '@e1', role: 'button', testId: 'com.google.android.youtube:id/search' }] }) } as unknown as DeviceBackend);
    expect(await c.foregroundApp('OWN0000002')).toBe('com.google.android.youtube');
  });
});

describe('connectDevices', () => {
  it('발견 파일의 데몬이 살아 있고 응답하면 데몬 RPC 에 붙는다(직접 열지 않음)', async () => {
    const server = await serveHttp(createDeviceServer([fakeBackend('DAEMON0001', 'SM-N981N')]));
    const file = path.join(dir, 'device-rpc.json');
    await publishDeviceRpc(file, { port: server.port, token: server.token, pid: process.pid, agentId: 'node-1' });
    let opened = 0;
    const c = await connectDevices({ discoveryFile: file, openOwn: async () => { opened++; throw new Error('열면 안 됨'); } });
    expect(c.connection).toMatchObject({ mode: 'daemon', detail: expect.stringMatching(/node-1/) });
    expect((await c.listDevices()).map((d) => [d.id, d.model])).toEqual([['DAEMON0001', 'SM-N981N']]);
    expect(opened).toBe(0);
    await c.close();
    await server.close();
  });

  it('발견 파일이 없거나 데몬이 응답하지 않으면 직접 연다', async () => {
    const file = path.join(dir, 'device-rpc.json');
    await publishDeviceRpc(file, { port: 1, token: 't', pid: process.pid }); // 살아 있는 pid 지만 포트가 닫혀 있다
    let closed = 0;
    const c = await connectDevices({ discoveryFile: file, probeTimeoutMs: 500, openOwn: async () => ({ rpc: rpcOverDispatcher(createDeviceServer([fakeBackend('OWN0000002', 'Pixel 7')])), close: async () => { closed++; } }) });
    expect(c.connection).toMatchObject({ mode: 'own' });
    expect((await c.listDevices()).map((d) => d.id)).toEqual(['OWN0000002']);
    await c.close();
    expect(closed).toBe(1);
  });

  it('직접 열기도 실패하면 none 과 사유(기기 목록은 빈 배열)', async () => {
    const c = await connectDevices({ discoveryFile: path.join(dir, 'none.json'), openOwn: async () => { throw new Error('USB 를 열 수 없음'); } });
    expect(c.connection).toEqual({ mode: 'none', detail: expect.stringMatching(/USB 를 열 수 없음/) });
    expect(await c.listDevices()).toEqual([]);
  });
});
