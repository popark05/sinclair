// Studio IPC 계약(studio 01, ADR 0005): 렌더러 ↔ 메인(preload 채널)과 메인 ↔ 작업 프로세스(Node IPC) 메시지의 단일 정의.
// 모두 구조화 복제 가능한 평범한 데이터만. 작업 프로세스에서 온 메시지는 parseFromWorker 를 지나야 쓴다.

/** 렌더러 ↔ 메인 채널(ipcMain.handle / webContents.send) */
export const STUDIO_CHANNELS = {
  ping: 'studio:ping',
  workerStatus: 'studio:worker-status',
  workerStatusChanged: 'studio:worker-status-changed',
  request: 'studio:request',
} as const;

/** 렌더러가 작업 프로세스에 묻는 것(메인이 parseStudioRequest 로 거른 뒤 그대로 넘긴다). 닫힌 집합 */
export type StudioRequest = { kind: 'connection' } | { kind: 'devices' } | { kind: 'foreground-app'; deviceId: string };

/** 기기 연결 방식: 데몬의 디바이스 RPC 에 붙음 / 작업 프로세스가 직접 엶 / 없음(사유) */
export interface ConnectionInfo { mode: 'daemon' | 'own' | 'none'; detail: string }

/** 툴바에 보이는 기기(protocol DeviceInfo 에서 화면에 필요한 것만) */
export interface StudioDevice { id: string; model: string; osVersion: string; state: string; stateDetail?: string; helper?: string }

/** 요청별 응답 타입 */
export interface StudioResponses { connection: ConnectionInfo; devices: StudioDevice[]; 'foreground-app': string | null }

/** 작업 프로세스 상태: 띄우는 중 → 준비됨 → (죽으면) 종료됨 */
export interface WorkerStatus {
  state: 'starting' | 'ready' | 'exited';
  /** 작업 프로세스의 Node 버전(process.version) */
  node?: string;
  pid?: number;
  /** 종료 사유(띄우지 못함·비정상 종료) */
  error?: string;
}

/** 메인 → 작업 프로세스 */
export type ToWorker = { type: 'ping'; id: string; delayMs?: number } | { type: 'request'; id: string; request: StudioRequest };
/** 작업 프로세스 → 메인 */
export type FromWorker =
  | { type: 'ready'; node: string; pid: number }
  | { type: 'pong'; id: string; node: string; pid: number }
  | { type: 'response'; id: string; ok: true; value: unknown }
  | { type: 'response'; id: string; ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseFromWorker(v: unknown): FromWorker | undefined {
  if (!isRecord(v)) return undefined;
  if (v.type === 'ready' && typeof v.node === 'string' && typeof v.pid === 'number') return { type: 'ready', node: v.node, pid: v.pid };
  if (v.type === 'pong' && typeof v.id === 'string' && typeof v.node === 'string' && typeof v.pid === 'number') return { type: 'pong', id: v.id, node: v.node, pid: v.pid };
  if (v.type === 'response' && typeof v.id === 'string') {
    if (v.ok === true) return { type: 'response', id: v.id, ok: true, value: v.value };
    if (v.ok === false && typeof v.error === 'string') return { type: 'response', id: v.id, ok: false, error: v.error };
  }
  return undefined;
}

/** 렌더러에서 온 요청 검사(렌더러는 믿지 않는다): 알려진 kind 와 맞는 필드만 */
export function parseStudioRequest(v: unknown): StudioRequest | undefined {
  if (!isRecord(v)) return undefined;
  if (v.kind === 'connection') return { kind: 'connection' };
  if (v.kind === 'devices') return { kind: 'devices' };
  if (v.kind === 'foreground-app' && typeof v.deviceId === 'string' && v.deviceId) return { kind: 'foreground-app', deviceId: v.deviceId };
  return undefined;
}

/** preload 가 렌더러에 window.sinclair 로 노출하는 API */
export interface StudioApi {
  getWorkerStatus(): Promise<WorkerStatus>;
  /** 상태가 바뀔 때마다. 돌려준 함수로 구독 해제 */
  onWorkerStatus(cb: (s: WorkerStatus) => void): () => void;
  ping(): Promise<{ roundTripMs: number; node: string }>;
  connection(): Promise<ConnectionInfo>;
  listDevices(): Promise<StudioDevice[]>;
  /** 기기의 지금 화면을 차지한 앱(화면 트리의 리소스 id 패키지). 모르면 null */
  foregroundApp(deviceId: string): Promise<string | null>;
}
