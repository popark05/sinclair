// Studio 작업 프로세스(ADR 0005): plain Node 로 돌아 기기·러너·에이전트를 맡는다.
// Electron 의 Node(BoringSSL)가 아니라 순정 Node 라 TLS·사내망 CA·네이티브 모듈(node-usb) 경로가 runner-agent 와 같다.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createAndroidBackend, createDeviceServer, defaultDiscoveryFile } from '@sinclair/device-layer';
import { rpcOverDispatcher } from '@sinclair/engine-mobile';
import type { FromWorker, StudioRequest, StudioResponses, ToWorker } from '../shared/studio-ipc.ts';
import { connectDevices, type DeviceConnection } from './device-session.ts';

const send = (m: FromWorker): void => { process.send?.(m); };

/** 헬퍼 APK: SINCLAIR_STUDIO_HELPER_APK, 없으면 리포 빌드 산출물(개발). 없어도 열 수는 있다(헬퍼가 이미 깔린 기기) */
function helperApk(): string | undefined {
  if (process.env.SINCLAIR_STUDIO_HELPER_APK) return process.env.SINCLAIR_STUDIO_HELPER_APK;
  const repo = path.resolve(import.meta.dirname, '../../../../packages/device-layer/android-helper/app/build/outputs/apk/debug/app-debug.apk');
  return existsSync(repo) ? repo : undefined;
}

let connection: Promise<DeviceConnection> | undefined;
const devices = (): Promise<DeviceConnection> => (connection ??= connectDevices({
  discoveryFile: process.env.SINCLAIR_DEVICE_RPC_FILE || defaultDiscoveryFile(process.env),
  openOwn: async () => {
    const apk = helperApk();
    const backend = createAndroidBackend({ dadb: { includeEmulators: true }, ...(apk ? { helperApkPath: apk } : {}) });
    return { rpc: rpcOverDispatcher(createDeviceServer([backend])), close: () => backend.close() };
  },
}));

async function handle(req: StudioRequest): Promise<StudioResponses[StudioRequest['kind']]> {
  const c = await devices();
  if (req.kind === 'connection') return c.connection;
  if (req.kind === 'devices') return c.listDevices();
  return c.foregroundApp(req.deviceId);
}

process.on('message', (raw: unknown) => {
  const m = raw as ToWorker;
  if (m?.type === 'ping' && typeof m.id === 'string') {
    const reply = () => send({ type: 'pong', id: m.id, node: process.version, pid: process.pid });
    if (m.delayMs) setTimeout(reply, m.delayMs); else reply();
    return;
  }
  if (m?.type === 'request' && typeof m.id === 'string') {
    handle(m.request).then(
      (value) => send({ type: 'response', id: m.id, ok: true, value }),
      (err: unknown) => send({ type: 'response', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }
});
// 메인이 사라지면(IPC 끊김) 곧바로 끝난다 — 고아로 남아 기기를 잡고 있지 않게
process.on('disconnect', () => { void (connection ? connection.then((c) => c.close()).catch(() => {}) : Promise.resolve()).finally(() => process.exit(0)); });
send({ type: 'ready', node: process.version, pid: process.pid });
