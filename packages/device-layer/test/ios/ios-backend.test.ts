// @vitest-environment node
// iOS DeviceBackend(ios-backend 03): usbmux 기기 + lockdown 정보 → DeviceInfo, 러너가 없으면 실행기로 띄우고 /ping 까지 기다린 뒤 화면·입력·앱을 러너로.
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type * as net from 'node:net';
import { createUsbmuxClient } from '../../src/ios/usbmux.ts';
import { createIosBackend, noLauncher, type IosRunnerLauncher } from '../../src/ios/ios-backend.ts';
import { startFakeUsbmuxd, fakeLockdownd } from './fake-usbmuxd.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const UDID = '00008020-000B289011E2002E';

/** 기기 안 러너 흉내: 실행기가 띄워야(토큰을 받아야) 답한다 */
function fakeRunner() {
  const state = { token: '' as string, actions: [] as unknown[], apps: [] as unknown[], foreground: 'com.apple.springboard' };
  const tree = { type: 'Application', frame: { x: 0, y: 0, width: 414, height: 896 }, enabled: true, selected: false, children: [{ type: 'Button', label: '설정', identifier: 'settings', frame: { x: 10, y: 10, width: 100, height: 44 }, enabled: true, selected: false, children: [] }] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (!state.token || req.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: '토큰' });
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.url === '/ping') return send(200, { ok: true, version: '0.1.0', iosVersion: '17.6.1', model: 'iPhone11,6', screen: { width: 414, height: 896 }, scale: 3 });
      if (req.url?.startsWith('/dump')) return send(200, { root: tree });
      if (req.url === '/snapshot') return send(200, { root: tree, screenshot: Buffer.from('PNG!').toString('base64') });
      if (req.url === '/app/foreground') return send(200, { bundleId: state.foreground });
      if (req.url === '/action') { state.actions.push(body); return send(200, { ok: true }); }
      if (req.url === '/app') { state.apps.push(body); return send(200, { ok: true }); }
      return send(404, {});
    });
  });
  return { state, handler: (s: net.Socket) => { server.emit('connection', s); } };
}

async function setup(launcherOk = true) {
  const runner = fakeRunner();
  const fake = await startFakeUsbmuxd([{ deviceId: 1, udid: UDID, connection: 'USB', ports: { 62078: fakeLockdownd({ DeviceName: '아이폰', ProductType: 'iPhone11,6', ProductVersion: '17.6.1' }), 22087: runner.handler } }]);
  cleanups.push(() => fake.close());
  const starts: string[] = [];
  const launcher: IosRunnerLauncher = { async start(udid, token) { starts.push(udid); if (launcherOk) runner.state.token = token; else throw new Error('xcodebuild 없음'); return { stop: async () => { runner.state.token = ''; } }; } };
  const backend = createIosBackend({ usbmux: createUsbmuxClient({ socketPath: fake.socketPath }), launcher, readyTimeoutMs: 2_000 });
  cleanups.push(() => backend.close());
  return { backend, runner, starts };
}

describe('createIosBackend', () => {
  it('기기 목록: UDID·모델·iOS 버전(lockdown), 러너를 띄워 ready', async () => {
    const { backend, starts } = await setup();
    const [d] = await backend.listDevices();
    expect(d).toMatchObject({ id: UDID, platform: 'ios', model: 'iPhone11,6', osVersion: '17.6.1', state: 'device' });
    await backend.dumpUi(UDID);
    expect((await backend.info(UDID)).helper).toEqual({ state: 'ready', version: '0.1.0' });
    expect(starts).toEqual([UDID]);
  });

  it('화면(픽셀 트리·스냅샷)·입력(픽셀 → 포인트)·키·뒤로(왼쪽 가장자리 스와이프)·앱·앞 화면 앱', async () => {
    const { backend, runner } = await setup();
    expect(await backend.dumpUi(UDID)).toMatchObject({ role: 'root', children: [{ role: 'button', name: '설정', testId: 'settings', rect: { x: 30, y: 30 } }] });
    expect(await backend.snapshot(UDID)).toMatchObject({ atomic: true, screenshot: { base64: Buffer.from('PNG!').toString('base64') } });
    await backend.tap(UDID, { x: 300, y: 600 });
    await backend.text(UDID, 'qa');
    await backend.keys(UDID, ['KEYCODE_ENTER']);
    await backend.button(UDID, 'back');
    await backend.button(UDID, 'home');
    await backend.launchApp(UDID, 'com.apple.Preferences');
    await backend.terminateApp(UDID, 'com.apple.Preferences');
    expect(await backend.foregroundApp!(UDID)).toBe('com.apple.springboard');
    expect(runner.state.actions).toEqual([
      { action: 'tap', x: 100, y: 200 },
      { action: 'type', text: 'qa' },
      { action: 'key', key: 'return' },
      { action: 'swipe', fromX: 1, fromY: 448, toX: 276, toY: 448, durationMs: 300 },
      { action: 'button', button: 'home' },
    ]);
    expect(runner.state.apps).toEqual([{ action: 'launch', bundleId: 'com.apple.Preferences' }, { action: 'terminate', bundleId: 'com.apple.Preferences' }]);
    await expect(backend.keys(UDID, ['KEYCODE_CAMERA'])).rejects.toThrow(/iOS 에서 지원하지 않는 키/);
  });

  it('러너를 띄우지 못하면 helper 가 unreachable(사유), 화면 호출은 사유와 함께 실패', async () => {
    const { backend } = await setup(false);
    await expect(backend.dumpUi(UDID)).rejects.toThrow(/xcodebuild 없음/);
    expect((await backend.info(UDID)).helper).toMatchObject({ state: 'unreachable', detail: expect.stringMatching(/xcodebuild 없음/) });
  });

  it('러너를 아직 띄우지 않은 기기는 helper 없음(필요할 때 띄운다 — Fleet 후보를 막지 않는다); 실행기가 없으면 처음부터 unreachable(빌드 안내)', async () => {
    const { backend, starts } = await setup();
    const [d] = await backend.listDevices();
    expect(d!.helper).toBeUndefined();
    expect(starts).toEqual([]);
    const fake = await startFakeUsbmuxd([{ deviceId: 1, udid: UDID, connection: 'USB', ports: { 62078: fakeLockdownd({ ProductType: 'iPhone11,6', ProductVersion: '17.6.1' }) } }]);
    cleanups.push(() => fake.close());
    const none = createIosBackend({ usbmux: createUsbmuxClient({ socketPath: fake.socketPath }), launcher: noLauncher });
    cleanups.push(() => none.close());
    expect((await none.listDevices())[0]!.helper).toMatchObject({ state: 'unreachable', detail: expect.stringMatching(/SINCLAIR_IOS_XCTESTRUN/) });
  });

  it('러너 프로세스가 끝나면 unreachable(사유), 다음 호출에서 다시 띄운다', async () => {
    const runner = fakeRunner();
    const fake = await startFakeUsbmuxd([{ deviceId: 1, udid: UDID, connection: 'USB', ports: { 62078: fakeLockdownd({ ProductType: 'iPhone11,6', ProductVersion: '17.6.1' }), 22087: runner.handler } }]);
    cleanups.push(() => fake.close());
    const exits: Array<(d: string) => void> = [];
    const launcher: IosRunnerLauncher = { async start(_u, token, hooks) { runner.state.token = token; if (hooks) exits.push(hooks.onExit); return { stop: async () => {} }; } };
    const backend = createIosBackend({ usbmux: createUsbmuxClient({ socketPath: fake.socketPath }), launcher, readyTimeoutMs: 2_000 });
    cleanups.push(() => backend.close());
    await backend.dumpUi(UDID);
    runner.state.token = '';
    exits[0]!('xcodebuild 종료(코드 65): 기기 잠금을 풀어야 함');
    expect((await backend.info(UDID)).helper).toMatchObject({ state: 'unreachable', detail: expect.stringMatching(/잠금/) });
    await backend.dumpUi(UDID);
    expect(exits).toHaveLength(2);
    expect((await backend.info(UDID)).helper).toMatchObject({ state: 'ready' });
  });

  it('기다리는 중에 러너 프로세스가 끝나면 기한을 기다리지 않고 그 사유로 실패', async () => {
    const fake = await startFakeUsbmuxd([{ deviceId: 1, udid: UDID, connection: 'USB', ports: { 62078: fakeLockdownd({ ProductType: 'iPhone11,6', ProductVersion: '17.6.1' }) } }]);
    cleanups.push(() => fake.close());
    const launcher: IosRunnerLauncher = { async start(_u, _t, hooks) { setTimeout(() => hooks?.onExit('xcodebuild 종료(코드 65): 기기 잠금을 풀어야 함'), 50); return { stop: async () => {} }; } };
    const backend = createIosBackend({ usbmux: createUsbmuxClient({ socketPath: fake.socketPath }), launcher, readyTimeoutMs: 60_000 });
    cleanups.push(() => backend.close());
    const t0 = Date.now();
    await expect(backend.dumpUi(UDID)).rejects.toThrow(/잠금을 풀어야/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('설치 확인(appInstalled): 없는 앱 실행은 러너에 보내지 않고 바로 실패(러너가 1분 넘게 붙잡히지 않게), 없는 앱 종료는 무시, 모르면 그대로 보낸다', async () => {
    const runner = fakeRunner();
    const fake = await startFakeUsbmuxd([{ deviceId: 1, udid: UDID, connection: 'USB', ports: { 62078: fakeLockdownd({ ProductType: 'iPhone11,6', ProductVersion: '17.6.1' }), 22087: runner.handler } }]);
    cleanups.push(() => fake.close());
    const launcher: IosRunnerLauncher = { async start(_u, token) { runner.state.token = token; return { stop: async () => {} }; } };
    const known: Record<string, boolean | undefined> = { 'com.apple.Preferences': true, 'com.google.android.youtube': false };
    const backend = createIosBackend({ usbmux: createUsbmuxClient({ socketPath: fake.socketPath }), launcher, readyTimeoutMs: 2_000, appInstalled: async (udid, id) => { expect(udid).toBe(UDID); return known[id]; } });
    cleanups.push(() => backend.close());
    await expect(backend.launchApp(UDID, 'com.google.android.youtube')).rejects.toThrow(/설치되지 않은 앱: com.google.android.youtube/);
    await backend.terminateApp(UDID, 'com.google.android.youtube');
    await backend.launchApp(UDID, 'com.apple.Preferences');
    await backend.launchApp(UDID, 'com.unknown.app');
    expect(runner.state.apps).toEqual([{ action: 'launch', bundleId: 'com.apple.Preferences' }, { action: 'launch', bundleId: 'com.unknown.app' }]);
  });
});

