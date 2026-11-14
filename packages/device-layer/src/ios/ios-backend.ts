// iOS DeviceBackend(ios-backend 03): usbmux 로 기기를 알고(lockdown 의 모델·iOS 버전), 기기 안 XCUITest 러너(포트 22087)로 화면·입력·앱을 다룬다.
// 러너가 답하지 않으면 실행기(기본 xcodebuild test-without-building)로 띄우고 /ping 까지 기다린다 — 상태는 DeviceInfo.helper(ready·pending·unreachable).
// iOS 에는 하드웨어 뒤로 버튼이 없어 back 은 왼쪽 가장자리 스와이프(시스템 뒤로 제스처)다.
import { randomBytes } from 'node:crypto';
import type { DeviceButton, DeviceInfo, HelperInfo, Point, SemanticNode, SnapshotResult } from '@sinclair/protocol';
import type { DeviceBackend } from '../backend.ts';
import { RpcError, RPC_ERRORS } from '../rpc.ts';
import { createUsbmuxClient, forwardPort, readLockdownValues, type UsbmuxClient } from './usbmux.ts';
import { IosRunnerClient, IOS_RUNNER_PORT, type IosRunnerPing } from './runner-client.ts';

/** 기기 안 러너를 띄운다. token 은 러너가 요청을 받을 Bearer 토큰(러너에 환경변수로 전한다) */
export interface IosRunnerLauncher { start(udid: string, token: string): Promise<{ stop(): Promise<void> }> }
export interface IosBackendOptions {
  usbmux?: UsbmuxClient;
  launcher?: IosRunnerLauncher;
  /** 러너가 /ping 에 답하기까지 기다리는 상한(xcodebuild 기동은 수십 초) */
  readyTimeoutMs?: number;
  onStep?: (udid: string, text: string) => void;
}

const KEYS: Record<string, string> = {
  KEYCODE_ENTER: 'return', KEYCODE_DEL: 'delete', KEYCODE_FORWARD_DEL: 'forwardDelete', KEYCODE_TAB: 'tab', KEYCODE_ESCAPE: 'escape', KEYCODE_SPACE: 'space',
  KEYCODE_DPAD_UP: 'upArrow', KEYCODE_DPAD_DOWN: 'downArrow', KEYCODE_DPAD_LEFT: 'leftArrow', KEYCODE_DPAD_RIGHT: 'rightArrow',
};

interface Tracked {
  deviceId: number;
  info?: { model?: string; osVersion?: string };
  helper: HelperInfo;
  client?: IosRunnerClient;
  ping?: IosRunnerPing;
  forward?: { port: number; close(): Promise<void> };
  runner?: { stop(): Promise<void> };
  starting?: Promise<IosRunnerClient>;
}

/** 실행기 없음: 러너 빌드(.xctestrun)를 지정하라는 안내로 실패 */
export const noLauncher: IosRunnerLauncher = { async start() { throw new Error('iOS 러너 실행기가 없음 — Xcode 로 packages/device-layer/ios-runner 를 build-for-testing 하고 SINCLAIR_IOS_XCTESTRUN 에 .xctestrun 경로를 지정'); } };

export function createIosBackend(opts: IosBackendOptions = {}): DeviceBackend & { foregroundApp(id: string): Promise<string | undefined>; close(): Promise<void> } {
  const usbmux = opts.usbmux ?? createUsbmuxClient();
  const launcher = opts.launcher ?? noLauncher;
  const tracked = new Map<string, Tracked>();
  const step = (udid: string, t: string): void => opts.onStep?.(udid, t);

  const refresh = async (): Promise<Array<[string, Tracked]>> => {
    const list = (await usbmux.listDevices().catch(() => [])).filter((d) => d.connection === 'USB');
    for (const d of list) {
      let t = tracked.get(d.udid);
      if (!t) { t = { deviceId: d.deviceId, helper: { state: 'pending' } }; tracked.set(d.udid, t); }
      t.deviceId = d.deviceId;
      if (!t.info) {
        const v = await readLockdownValues(usbmux, d.deviceId).catch(() => ({} as { productType?: string; productVersion?: string }));
        t.info = { ...(v.productType ? { model: v.productType } : {}), ...(v.productVersion ? { osVersion: v.productVersion } : {}) };
      }
    }
    for (const udid of tracked.keys()) if (!list.some((d) => d.udid === udid)) { void drop(udid); }
    return list.map((d) => [d.udid, tracked.get(d.udid)!]);
  };
  const drop = async (udid: string): Promise<void> => {
    const t = tracked.get(udid);
    tracked.delete(udid);
    await t?.forward?.close().catch(() => {});
    await t?.runner?.stop().catch(() => {});
  };
  const toInfo = (udid: string, t: Tracked): DeviceInfo => ({ id: udid, platform: 'ios', model: t.ping?.model ?? t.info?.model ?? 'iPhone', osVersion: t.ping?.iosVersion ?? t.info?.osVersion ?? '', state: 'device', helper: t.helper });

  const find = async (udid: string): Promise<Tracked> => {
    if (!tracked.has(udid)) await refresh();
    const t = tracked.get(udid);
    if (!t) throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${udid}`);
    return t;
  };

  /** 러너가 답할 때까지(필요하면 띄워서). 동시에 불려도 한 번만 띄운다 */
  const runner = async (udid: string): Promise<IosRunnerClient> => {
    const t = await find(udid);
    if (t.client && t.helper.state === 'ready') return t.client;
    t.starting ??= (async () => {
      t.forward ??= await forwardPort(usbmux, t.deviceId, IOS_RUNNER_PORT);
      const token = randomBytes(16).toString('hex');
      step(udid, '러너 실행');
      try {
        t.runner = await launcher.start(udid, token);
      } catch (err) {
        t.helper = { state: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
        throw new RpcError(RPC_ERRORS.helperUnavailable, `iOS 러너를 띄우지 못함: ${t.helper.detail}`);
      }
      const client = new IosRunnerClient(t.forward.port, token);
      const deadline = Date.now() + (opts.readyTimeoutMs ?? 120_000);
      let last = '';
      for (;;) {
        try {
          t.ping = await client.ping();
          t.client = client;
          t.helper = { state: 'ready', version: t.ping.version };
          step(udid, `러너 준비됨 v${t.ping.version}`);
          return client;
        } catch (err) { last = err instanceof Error ? err.message : String(err); }
        if (Date.now() >= deadline) {
          t.helper = { state: 'unreachable', detail: `러너가 ${opts.readyTimeoutMs ?? 120_000}ms 안에 답하지 않음: ${last}` };
          await t.runner?.stop().catch(() => {});
          throw new RpcError(RPC_ERRORS.helperUnavailable, `iOS 러너 사용 불가: ${t.helper.detail}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })().finally(() => { delete t.starting; });
    return t.starting;
  };

  /** 화면 크기(픽셀): 러너 ping 의 포인트 × 배율 */
  const screenPx = async (udid: string): Promise<{ w: number; h: number }> => {
    const t = await find(udid);
    if (!t.ping) await runner(udid);
    const p = t.ping!;
    return { w: Math.round(p.screen.width * p.scale), h: Math.round(p.screen.height * p.scale) };
  };
  /** 시스템 뒤로: 왼쪽 가장자리에서 오른쪽으로 화면 2/3 까지 */
  const back = async (udid: string): Promise<void> => {
    const { w, h } = await screenPx(udid);
    const t = (await find(udid)).ping!;
    await (await runner(udid)).swipe({ x: Math.round(t.scale * 1), y: Math.round(h / 2) }, { x: Math.round((w * 2) / 3), y: Math.round(h / 2) }, 300);
  };

  return {
    platform: 'ios',
    async listDevices() { return (await refresh()).map(([udid, t]) => toInfo(udid, t)); },
    async info(udid) { return toInfo(udid, await find(udid)); },
    async screenshot(udid) { const s = await (await runner(udid)).snapshot(); return Buffer.from(s.screenshot.base64, 'base64'); },
    async dumpUi(udid): Promise<SemanticNode> { return (await runner(udid)).dump(); },
    async snapshot(udid): Promise<SnapshotResult> { const capturedAt = new Date().toISOString(); return { ...(await (await runner(udid)).snapshot()), capturedAt }; },
    async tap(udid, p: Point) { await (await runner(udid)).tap(p); },
    async longPress(udid, p: Point, durationMs: number) { await (await runner(udid)).longPress(p, durationMs); },
    async swipe(udid, a: Point, b: Point, durationMs: number) { await (await runner(udid)).swipe(a, b, durationMs); },
    async text(udid, text: string) { await (await runner(udid)).type(text); },
    async keys(udid, keys: string[]) {
      for (const k of keys) {
        if (k === 'KEYCODE_BACK') { await back(udid); continue; }
        if (k === 'KEYCODE_HOME') { await (await runner(udid)).button('home'); continue; }
        const key = KEYS[k];
        if (!key) throw new RpcError(RPC_ERRORS.invalidParams, `iOS 에서 지원하지 않는 키: ${k}`);
        await (await runner(udid)).key(key);
      }
    },
    async button(udid, name: DeviceButton) {
      if (name === 'back') return back(udid);
      if (name === 'power') throw new RpcError(RPC_ERRORS.invalidParams, 'iOS 에서 전원 버튼은 누를 수 없음');
      await (await runner(udid)).button(name);
    },
    async launchApp(udid, appId) { await (await runner(udid)).app('launch', appId); },
    async terminateApp(udid, appId) { await (await runner(udid)).app('terminate', appId); },
    async openUrl() { throw new RpcError(RPC_ERRORS.invalidParams, 'iOS 의 URL 열기는 아직 지원하지 않음'); },
    async foregroundApp(udid) { return (await (await runner(udid)).foreground()) ?? undefined; },
    async close() { for (const udid of tracked.keys()) await drop(udid); },
  };
}
