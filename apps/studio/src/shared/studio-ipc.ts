// Studio IPC 계약(studio 01, ADR 0005): 렌더러 ↔ 메인(preload 채널)과 메인 ↔ 작업 프로세스(Node IPC) 메시지의 단일 정의.
// 모두 구조화 복제 가능한 평범한 데이터만. 작업 프로세스에서 온 메시지는 parseFromWorker 를 지나야 쓴다.
import type { SemanticNode } from '@sinclair/protocol';

/** 렌더러 ↔ 메인 채널(ipcMain.handle / webContents.send) */
export const STUDIO_CHANNELS = {
  ping: 'studio:ping',
  workerStatus: 'studio:worker-status',
  workerStatusChanged: 'studio:worker-status-changed',
  request: 'studio:request',
} as const;

/** 렌더러가 작업 프로세스에 묻는 것(메인이 parseStudioRequest 로 거른 뒤 그대로 넘긴다). 닫힌 집합 */
export type StudioRequest =
  | { kind: 'connection' } | { kind: 'devices' } | { kind: 'foreground-app'; deviceId: string }
  // 기기 화면·조작(studio 03)
  | { kind: 'snapshot'; deviceId: string }
  | { kind: 'tap'; deviceId: string; x: number; y: number }
  | { kind: 'swipe'; deviceId: string; fromX: number; fromY: number; toX: number; toY: number; durationMs: number }
  | { kind: 'text'; deviceId: string; text: string }
  | { kind: 'key'; deviceId: string; key: StudioKey }
  | { kind: 'button'; deviceId: string; button: 'back' | 'home' };

/** 화면 키보드 대신 보내는 키(작업 프로세스가 KEYCODE 로 바꾼다). 닫힌 집합 — 전원 등 기기 상태를 바꾸는 키는 없다 */
export const STUDIO_KEYS = ['enter', 'backspace', 'tab', 'escape', 'up', 'down', 'left', 'right'] as const;
export type StudioKey = (typeof STUDIO_KEYS)[number];

/** 기기 화면 한 장: 스크린샷(PNG base64)과 같은 순간의 트리(Inspector 가 쓴다) */
export interface StudioSnapshot { png: string; root: SemanticNode; capturedAt: string }

/** 기기 연결 방식: 데몬의 디바이스 RPC 에 붙음 / 작업 프로세스가 직접 엶 / 없음(사유) */
export interface ConnectionInfo { mode: 'daemon' | 'own' | 'none'; detail: string }

/** 툴바에 보이는 기기(protocol DeviceInfo 에서 화면에 필요한 것만) */
export interface StudioDevice { id: string; model: string; osVersion: string; state: string; stateDetail?: string; helper?: string }

/** 요청별 응답 타입 */
export interface StudioResponses { connection: ConnectionInfo; devices: StudioDevice[]; 'foreground-app': string | null; snapshot: StudioSnapshot; tap: null; swipe: null; text: null; key: null; button: null }

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
/** 화면 좌표: 0~20000 의 유한한 수 → 정수 */
const coord = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20_000 ? Math.round(v) : undefined);
const MAX_TEXT = 500;

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
  if (typeof v.deviceId !== 'string' || !v.deviceId) return undefined;
  const deviceId = v.deviceId;
  if (v.kind === 'foreground-app') return { kind: 'foreground-app', deviceId };
  if (v.kind === 'snapshot') return { kind: 'snapshot', deviceId };
  if (v.kind === 'tap') { const x = coord(v.x), y = coord(v.y); return x !== undefined && y !== undefined ? { kind: 'tap', deviceId, x, y } : undefined; }
  if (v.kind === 'swipe') {
    const [fromX, fromY, toX, toY] = [coord(v.fromX), coord(v.fromY), coord(v.toX), coord(v.toY)];
    const d = typeof v.durationMs === 'number' && v.durationMs >= 50 && v.durationMs <= 5_000 ? Math.round(v.durationMs) : undefined;
    return fromX !== undefined && fromY !== undefined && toX !== undefined && toY !== undefined && d !== undefined ? { kind: 'swipe', deviceId, fromX, fromY, toX, toY, durationMs: d } : undefined;
  }
  if (v.kind === 'text') return typeof v.text === 'string' && v.text.length > 0 && v.text.length <= MAX_TEXT ? { kind: 'text', deviceId, text: v.text } : undefined;
  if (v.kind === 'key') return (STUDIO_KEYS as readonly unknown[]).includes(v.key) ? { kind: 'key', deviceId, key: v.key as StudioKey } : undefined;
  if (v.kind === 'button') return v.button === 'back' || v.button === 'home' ? { kind: 'button', deviceId, button: v.button } : undefined;
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
  snapshot(deviceId: string): Promise<StudioSnapshot>;
  tap(deviceId: string, x: number, y: number): Promise<void>;
  swipe(deviceId: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  text(deviceId: string, text: string): Promise<void>;
  key(deviceId: string, key: StudioKey): Promise<void>;
  button(deviceId: string, button: 'back' | 'home'): Promise<void>;
}
