// 디바이스 RPC 발견 파일(studio 02, ADR 0005): 기기를 소유한 프로세스(데몬)가 로컬 디바이스 RPC(127.0.0.1·토큰)를 열면
// 포트·토큰·pid 를 OS 데이터 디렉터리에 남기고, 같은 머신의 Studio 가 읽어 붙는다 — 두 프로세스가 USB 를 다투지 않게.
// 토큰이 들어 있으므로 0600. 죽은 pid 의 파일은 없는 것으로 본다(데몬이 강제 종료돼 지우지 못한 경우).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DeviceRpcDiscovery {
  port: number;
  token: string;
  pid: number;
  /** 연 쪽(데몬 agentId 등) — 사람이 읽는 표시용 */
  agentId?: string;
  startedAt: string;
}

/** OS 데이터 디렉터리/sinclair/device-rpc.json (runner-agent·control-plane 의 데이터 디렉터리 규칙과 같다) */
export function defaultDiscoveryFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  const data = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'));
  return path.join(data, 'sinclair', 'device-rpc.json');
}

export async function publishDeviceRpc(file: string, info: Omit<DeviceRpcDiscovery, 'startedAt'>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...info, startedAt: new Date().toISOString() }), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

export async function readDeviceRpc(file: string): Promise<DeviceRpcDiscovery | undefined> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return undefined; }
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  if (typeof v !== 'object' || v === null) return undefined;
  const d = v as Record<string, unknown>;
  if (!Number.isInteger(d.port) || typeof d.token !== 'string' || !d.token || !Number.isInteger(d.pid) || typeof d.startedAt !== 'string') return undefined;
  if (!alive(d.pid as number)) return undefined;
  return { port: d.port as number, token: d.token, pid: d.pid as number, startedAt: d.startedAt, ...(typeof d.agentId === 'string' ? { agentId: d.agentId } : {}) };
}

/** 그 pid 가 남긴 파일만 지운다(다른 데몬이 그 사이 새로 쓴 파일을 지우지 않게) */
export async function unpublishDeviceRpc(file: string, pid: number): Promise<void> {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown };
    if (d.pid === pid) await fs.rm(file, { force: true });
  } catch { /* 없거나 깨졌으면 할 일 없음 */ }
}
