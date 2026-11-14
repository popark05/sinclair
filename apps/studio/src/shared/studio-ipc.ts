// Studio IPC 계약(studio 01, ADR 0005): 렌더러 ↔ 메인(preload 채널)과 메인 ↔ 작업 프로세스(Node IPC) 메시지의 단일 정의.
// 모두 구조화 복제 가능한 평범한 데이터만. 작업 프로세스에서 온 메시지는 parseFromWorker 를 지나야 쓴다.

/** 렌더러 ↔ 메인 채널(ipcMain.handle / webContents.send) */
export const STUDIO_CHANNELS = {
  ping: 'studio:ping',
  workerStatus: 'studio:worker-status',
  workerStatusChanged: 'studio:worker-status-changed',
} as const;

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
export type ToWorker = { type: 'ping'; id: string; delayMs?: number };
/** 작업 프로세스 → 메인 */
export type FromWorker = { type: 'ready'; node: string; pid: number } | { type: 'pong'; id: string; node: string; pid: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseFromWorker(v: unknown): FromWorker | undefined {
  if (!isRecord(v)) return undefined;
  if (v.type === 'ready' && typeof v.node === 'string' && typeof v.pid === 'number') return { type: 'ready', node: v.node, pid: v.pid };
  if (v.type === 'pong' && typeof v.id === 'string' && typeof v.node === 'string' && typeof v.pid === 'number') return { type: 'pong', id: v.id, node: v.node, pid: v.pid };
  return undefined;
}

/** preload 가 렌더러에 window.sinclair 로 노출하는 API */
export interface StudioApi {
  getWorkerStatus(): Promise<WorkerStatus>;
  /** 상태가 바뀔 때마다. 돌려준 함수로 구독 해제 */
  onWorkerStatus(cb: (s: WorkerStatus) => void): () => void;
  ping(): Promise<{ roundTripMs: number; node: string }>;
}
