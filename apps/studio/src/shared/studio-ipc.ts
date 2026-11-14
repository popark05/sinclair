// Studio IPC 계약(studio 01, ADR 0005): 렌더러 ↔ 메인(preload 채널)과 메인 ↔ 작업 프로세스(Node IPC) 메시지의 단일 정의.
// 모두 구조화 복제 가능한 평범한 데이터만. 작업 프로세스에서 온 메시지는 parseFromWorker 를 지나야 쓴다.
import type { CacheAction, CacheTarget, SemanticNode } from '@sinclair/protocol';
import type { StudioSettings } from './settings.ts';
import { EXPECT_MATCHERS, isExpectMatcher, parseLocatorQuery, type ExpectMatcher, type JudgeQuery } from './expect-judge.ts';

/** 렌더러 ↔ 메인 채널(ipcMain.handle / webContents.send) */
export const STUDIO_CHANNELS = {
  ping: 'studio:ping',
  workerStatus: 'studio:worker-status',
  workerStatusChanged: 'studio:worker-status-changed',
  request: 'studio:request',
  /** 작업 프로세스가 밀어 보내는 이벤트(세션 턴·끝) */
  event: 'studio:event',
  /** 내보낸 테스트를 파일로(메인의 저장 대화상자 — 작업 프로세스를 거치지 않는다) */
  saveTestFile: 'studio:save-test-file',
  /** Studio 설정 읽기·쓰기(메인 프로세스, studio-console 03) */
  getSettings: 'studio:get-settings',
  setSettings: 'studio:set-settings',
} as const;

/** 내보낸 코드 상한(파일 저장 요청 검사) */
export const MAX_EXPORT_BYTES = 1024 * 1024;

/** 렌더러가 작업 프로세스에 묻는 것(메인이 parseStudioRequest 로 거른 뒤 그대로 넘긴다). 닫힌 집합 */
export type StudioRequest =
  | { kind: 'connection' } | { kind: 'devices' } | { kind: 'foreground-app'; deviceId: string }
  // 기기 화면·조작(studio 03)
  | { kind: 'snapshot'; deviceId: string }
  | { kind: 'tap'; deviceId: string; x: number; y: number }
  | { kind: 'swipe'; deviceId: string; fromX: number; fromY: number; toX: number; toY: number; durationMs: number }
  | { kind: 'text'; deviceId: string; text: string }
  | { kind: 'key'; deviceId: string; key: StudioKey }
  | { kind: 'button'; deviceId: string; button: 'back' | 'home' }
  // 에이전트 세션(studio 05)
  | { kind: 'agent-status' }
  | { kind: 'session-start'; deviceId: string; goal: string; /** 이 앱을 처음 상태로 다시 띄운 뒤 시작(studio 08) */ restartApp?: string; /** 비밀값 이름 → 값(agent-secrets 03). 작업 프로세스 메모리에만 */ secrets?: Record<string, string> }
  | { kind: 'session-stop'; sessionId: string }
  | { kind: 'session-assert'; deviceId: string; statement: string }
  /** 요소 판정(studio 09): 고른 노드의 질의로 러너 expect 를 지금 화면에서(모델 없음) */
  | { kind: 'expect-check'; deviceId: string; query: JudgeQuery; matcher: ExpectMatcher; expected?: string }
  // 녹화를 control-plane 녹화 캐시에(studio 06)
  | { kind: 'save-recording'; controlPlane: string; testId: string; goal: string; app: string; recording: { actions: CacheAction[]; end: { anchors: CacheTarget[] } } };

/** 에이전트를 쓸 수 있는가(자격 증명·API 연결 — 과금 없는 점검). 못 쓰면 사유 */
export interface AgentStatus { ready: boolean; model?: string; reason?: string }
/** 세션 턴 하나(타임라인 한 줄). 모델이 쓴 입력 글자는 싣지 않는다 */
export interface TurnView { tool?: string; target?: string; result: 'ok' | 'rejected' | 'error'; detail?: string; guard?: 'gone' | 'ambiguous' | 'covered'; retargeted?: string;
  /** 그 턴에 모델이 본 화면에서 대상이 정확히 하나로 정해지는 locator 코드(결정적 내보내기) */
  locator?: string }
/** 세션이 끝났을 때 */
export interface SessionResult { ok: boolean; summary?: string; reason?: string; turns: number; modelCalls: number; inputTokens?: number; outputTokens?: number; recording?: { actions: CacheAction[]; end: { anchors: CacheTarget[] } };
  /** act 시작 화면의 앱(녹화 캐시 키·전제) */
  startApp?: string;
  /** 앱을 처음 상태로 다시 띄운 뒤 시작했다(내보낸 테스트의 app.restart 와 같은 시작 화면) */
  freshStart?: boolean;
  /** 에이전트가 blocked 로 멈춤(agent-secrets): 사유와 필요한 비밀값 이름 */
  blocked?: { reason: string; secret?: string } }
export type SessionEvent = { type: 'turn'; index: number; turn: TurnView } | { type: 'done'; result: SessionResult };
/** 작업 프로세스 → 메인 → 렌더러 푸시 */
export type StudioEvent = { kind: 'session'; sessionId: string; payload: SessionEvent };
export interface JudgeView { pass: boolean; reason: string }
/** 세션의 판정 하나: 문장(agent.assert, 모델) 또는 요소(expect, 결정적) */
export type Judgment = (JudgeView & { kind?: 'assert'; statement: string }) | (JudgeView & { kind: 'expect'; query: JudgeQuery; matcher: ExpectMatcher; expected?: string });

/** 비밀값 이름(에이전트 SECRET_NAME 과 같은 규칙)·한 세션의 개수 상한 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRETS = 10;

/** 앱 id(Android 패키지 이름 형식) — 기기 셸로 가는 값이라 형식만 받는다 */
export const APP_ID = /^(?=.{3,255}$)[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** 화면 키보드 대신 보내는 키(작업 프로세스가 KEYCODE 로 바꾼다). 닫힌 집합 — 전원 등 기기 상태를 바꾸는 키는 없다 */
export const STUDIO_KEYS = ['enter', 'backspace', 'tab', 'escape', 'up', 'down', 'left', 'right'] as const;
export type StudioKey = (typeof STUDIO_KEYS)[number];

/** 기기 화면 한 장: 스크린샷(PNG base64)과 같은 순간의 트리(Inspector 가 쓴다) */
export interface StudioSnapshot { png: string; root: SemanticNode; capturedAt: string }

/** 기기 연결 방식: 데몬의 디바이스 RPC 에 붙음 / 작업 프로세스가 직접 엶 / 없음(사유) */
export interface ConnectionInfo { mode: 'daemon' | 'own' | 'none'; detail: string }

/** 툴바에 보이는 기기(protocol DeviceInfo 에서 화면에 필요한 것만) */
export interface StudioDevice { id: string; model: string; osVersion: string; state: string; stateDetail?: string; helper?: string; /** 데몬에서 Run 이 이 기기를 쓰는 중 */ inUse?: boolean }

/** 요청별 응답 타입 */
export interface StudioResponses { connection: ConnectionInfo; devices: StudioDevice[]; 'foreground-app': string | null; snapshot: StudioSnapshot; tap: null; swipe: null; text: null; key: null; button: null;
  'agent-status': AgentStatus; 'session-start': { sessionId: string }; 'session-stop': null; 'session-assert': JudgeView; 'expect-check': JudgeView; 'save-recording': { key: string } }

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
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'event'; event: StudioEvent };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 화면 좌표: 0~20000 의 유한한 수 → 정수 */
const coord = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20_000 ? Math.round(v) : undefined);
const MAX_TEXT = 500;
/** 목표·판정 문장 상한 */
const MAX_GOAL = 2_000;

export function parseFromWorker(v: unknown): FromWorker | undefined {
  if (!isRecord(v)) return undefined;
  if (v.type === 'ready' && typeof v.node === 'string' && typeof v.pid === 'number') return { type: 'ready', node: v.node, pid: v.pid };
  if (v.type === 'pong' && typeof v.id === 'string' && typeof v.node === 'string' && typeof v.pid === 'number') return { type: 'pong', id: v.id, node: v.node, pid: v.pid };
  if (v.type === 'response' && typeof v.id === 'string') {
    if (v.ok === true) return { type: 'response', id: v.id, ok: true, value: v.value };
    if (v.ok === false && typeof v.error === 'string') return { type: 'response', id: v.id, ok: false, error: v.error };
  }
  if (v.type === 'event' && isRecord(v.event) && v.event.kind === 'session' && typeof v.event.sessionId === 'string' && isRecord(v.event.payload)) return { type: 'event', event: v.event as unknown as StudioEvent };
  return undefined;
}

/** 렌더러에서 온 요청 검사(렌더러는 믿지 않는다): 알려진 kind 와 맞는 필드만 */
export function parseStudioRequest(v: unknown): StudioRequest | undefined {
  if (!isRecord(v)) return undefined;
  if (v.kind === 'connection') return { kind: 'connection' };
  if (v.kind === 'devices') return { kind: 'devices' };
  if (v.kind === 'agent-status') return { kind: 'agent-status' };
  if (v.kind === 'save-recording') {
    // 녹화 항목은 작업 프로세스가 parseCacheEntry 로 다시 검사한다(여기선 모양만)
    if (typeof v.controlPlane !== 'string' || typeof v.testId !== 'string' || !v.testId || typeof v.goal !== 'string' || !v.goal || typeof v.app !== 'string' || !isRecord(v.recording) || !Array.isArray(v.recording.actions) || !isRecord(v.recording.end)) return undefined;
    return { kind: 'save-recording', controlPlane: v.controlPlane, testId: v.testId, goal: v.goal, app: v.app, recording: v.recording as never };
  }
  if (v.kind === 'session-stop') return typeof v.sessionId === 'string' && v.sessionId ? { kind: 'session-stop', sessionId: v.sessionId } : undefined;
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
  if (v.kind === 'session-start') {
    if (typeof v.goal !== 'string' || !v.goal.trim() || v.goal.length > MAX_GOAL) return undefined;
    if (v.restartApp !== undefined && !(typeof v.restartApp === 'string' && APP_ID.test(v.restartApp))) return undefined;
    let secrets: Record<string, string> | undefined;
    if (v.secrets !== undefined) {
      if (typeof v.secrets !== 'object' || v.secrets === null || Array.isArray(v.secrets)) return undefined;
      const entries = Object.entries(v.secrets as Record<string, unknown>);
      if (entries.length > MAX_SECRETS || entries.some(([k, val]) => !SECRET_NAME_RE.test(k) || typeof val !== 'string' || val.length < 4 || val.length > 200)) return undefined;
      secrets = Object.fromEntries(entries) as Record<string, string>;
    }
    return { kind: 'session-start', deviceId, goal: v.goal, ...(v.restartApp !== undefined ? { restartApp: v.restartApp as string } : {}), ...(secrets ? { secrets } : {}) };
  }
  if (v.kind === 'expect-check') {
    const query = parseLocatorQuery(v.query);
    if (!query || !isExpectMatcher(v.matcher)) return undefined;
    const needs = EXPECT_MATCHERS[v.matcher].needsValue;
    if (needs !== (v.expected !== undefined)) return undefined;
    if (needs && (typeof v.expected !== 'string' || v.expected.length > MAX_TEXT)) return undefined;
    return { kind: 'expect-check', deviceId, query, matcher: v.matcher, ...(needs ? { expected: v.expected as string } : {}) };
  }
  if (v.kind === 'session-assert') return typeof v.statement === 'string' && v.statement.trim() && v.statement.length <= MAX_GOAL ? { kind: 'session-assert', deviceId, statement: v.statement } : undefined;
  return undefined;
}

/** preload 가 렌더러에 window.sinclair 로 노출하는 API */
export interface StudioApi {
  /** Studio 설정(control-plane 주소·테스트 폴더) */
  getSettings(): Promise<StudioSettings>;
  setSettings(s: StudioSettings): Promise<StudioSettings>;
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
  agentStatus(): Promise<AgentStatus>;
  startSession(deviceId: string, goal: string, opts?: { restartApp?: string; secrets?: Record<string, string> }): Promise<{ sessionId: string }>;
  stopSession(sessionId: string): Promise<void>;
  /** 지금 화면에 대한 판정(agent.assert) */
  assertNow(deviceId: string, statement: string): Promise<JudgeView>;
  /** 요소 판정(studio 09) */
  expectCheck(deviceId: string, query: JudgeQuery, matcher: ExpectMatcher, expected?: string): Promise<JudgeView>;
  /** 작업 프로세스 이벤트 구독. 돌려준 함수로 해제 */
  onEvent(cb: (e: StudioEvent) => void): () => void;
  /** 세션 녹화를 control-plane 녹화 캐시에 */
  saveRecording(input: { controlPlane: string; testId: string; goal: string; app: string; recording: NonNullable<SessionResult['recording']> }): Promise<{ key: string }>;
  /** 내보낸 테스트 코드를 파일로(저장 대화상자). 저장한 경로, 취소면 null */
  saveTestFile(suggestedName: string, content: string): Promise<string | null>;
}
