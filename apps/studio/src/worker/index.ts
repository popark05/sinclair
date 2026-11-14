// Studio 작업 프로세스(ADR 0005): plain Node 로 돌아 기기·러너·에이전트를 맡는다.
// Electron 의 Node(BoringSSL)가 아니라 순정 Node 라 TLS·사내망 CA·네이티브 모듈(node-usb) 경로가 runner-agent 와 같다.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createAndroidBackend, createDeviceServer, defaultDiscoveryFile } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '@sinclair/engine-mobile';
import { agentFromEnv, claudeOptionsFromEnv, probeClaude, DEFAULT_AGENT_MODEL } from '@sinclair/agent';
import type { AgentStatus, FromWorker, StudioRequest, StudioResponses, ToWorker } from '../shared/studio-ipc.ts';
import { connectDevices, type DeviceConnection } from './device-session.ts';
import { createSessionManager, type SessionAgent } from './sessions.ts';
import { saveRecording } from './save-recording.ts';

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

// 에이전트: SINCLAIR_AGENT_* · ANTHROPIC_* 환경변수로(runner-agent 와 같은 설정). 실행기는 한 번 만들어 둔다
let agentSetup: SessionAgent | undefined;
const agent = async (): Promise<SessionAgent> => {
  if (agentSetup) return agentSetup;
  const status = await agentStatus();
  if (!status.ready) throw new Error(status.reason ?? '에이전트를 쓸 수 없음');
  const a = agentFromEnv(process.env);
  agentSetup = { executor: a.executor, ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}), ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}) };
  return agentSetup;
};
/** 자격 증명·API 연결 점검(토큰 세기 한 번, 과금 없음). 준비되면 기억, 아니면 다음에 다시 본다 */
let readyStatus: AgentStatus | undefined;
async function agentStatus(): Promise<AgentStatus> {
  if (readyStatus) return readyStatus;
  const model = process.env.SINCLAIR_AGENT_MODEL || DEFAULT_AGENT_MODEL;
  try {
    const r = await probeClaude(claudeOptionsFromEnv(process.env));
    if (r === 'ok') return (readyStatus = { ready: true, model });
    return { ready: false, model, reason: 'Claude API 에 닿지 않음 — 네트워크·사내망이면 NODE_EXTRA_CA_CERTS 를 확인' };
  } catch (err) {
    return { ready: false, model, reason: err instanceof Error ? err.message : String(err) };
  }
}
const sessions = createSessionManager({
  engineFor: async (deviceId) => {
    const c = await devices();
    if (!c.rpc) throw new Error(`기기 연결이 없음: ${c.connection.detail}`);
    return createMobileEngine(c.rpc, { deviceId });
  },
  agent,
  emit: (sessionId, payload) => send({ type: 'event', event: { kind: 'session', sessionId, payload } }),
});

async function handle(req: StudioRequest): Promise<StudioResponses[StudioRequest['kind']]> {
  if (req.kind === 'agent-status') return agentStatus();
  if (req.kind === 'session-start') return sessions.start(req.deviceId, req.goal, req.restartApp ? { restartApp: req.restartApp } : {});
  if (req.kind === 'session-stop') { await sessions.stop(req.sessionId); return null; }
  if (req.kind === 'session-assert') return sessions.assert(req.deviceId, req.statement);
  if (req.kind === 'expect-check') return sessions.expectCheck(req.deviceId, req.query, req.matcher, req.expected);
  if (req.kind === 'save-recording') return saveRecording(req);
  const c = await devices();
  if (req.kind === 'connection') return c.connection;
  switch (req.kind) {
    case 'devices': return c.listDevices();
    case 'foreground-app': return c.foregroundApp(req.deviceId);
    case 'snapshot': return c.snapshot(req.deviceId);
    case 'tap': await c.tap(req.deviceId, req.x, req.y); return null;
    case 'swipe': await c.swipe(req.deviceId, { x: req.fromX, y: req.fromY }, { x: req.toX, y: req.toY }, req.durationMs); return null;
    case 'text': await c.text(req.deviceId, req.text); return null;
    case 'key': await c.key(req.deviceId, req.key); return null;
    case 'button': await c.button(req.deviceId, req.button); return null;
  }
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
