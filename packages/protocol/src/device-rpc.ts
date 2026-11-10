import type { SemanticNode } from './engine.ts';
// 디바이스 레이어 JSON-RPC 메서드 이름. OpenRPC 문서는 이 목록에서 생성한다.
// 명명 체계는 mobilecli(FSL)의 설계를 참고했으며 구현은 독자적으로 한다.

export const DEVICE_RPC_METHODS = [
  'devices.list',
  'device.info',
  'device.screenshot',
  'device.screencapture',
  'device.dump.ui',
  'device.snapshot',
  'device.io.tap',
  'device.io.longpress',
  'device.io.swipe',
  'device.io.gesture',
  'device.io.text',
  'device.io.keys',
  'device.io.button',
  'device.io.keyboard',
  'device.apps.launch',
  'device.apps.terminate',
  'device.apps.install',
  'device.apps.uninstall',
  'device.apps.clear',
  'device.apps.foreground',
  'device.logs',
  'device.screenrecord',
  'device.clipboard.get',
  'device.clipboard.set',
  'device.url',
  'server.info',
] as const;
export type DeviceRpcMethod = (typeof DEVICE_RPC_METHODS)[number];

export interface JsonRpcRequest<M extends DeviceRpcMethod = DeviceRpcMethod> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

// ---- devices.list / device.info 응답 ----

export const DEVICE_PLATFORMS = ['android', 'ios'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** 디바이스 레이어가 보는 연결 상태. 제어 평면의 Device(idle/leased/…)와는 다른 축이다. */
export const DEVICE_CONNECTION_STATES = ['device', 'unauthorized', 'offline'] as const;
export type DeviceConnectionState = (typeof DEVICE_CONNECTION_STATES)[number];

/**
 * 온디바이스 헬퍼(접근성 서비스) 상태. ready 가 아니면 UI 트리·제스처를 쓸 수 없어 러너는 Run 을 blocked 처리한다.
 * pending: 온보딩 진행 중(판정 전) / not-installed: APK 없음·설치 실패 / disabled: 설치됐지만 접근성 서비스 꺼짐 /
 * unreachable: 켜졌지만 요청 거부 / ready. 필드 자체가 없으면 그 플랫폼에 헬퍼 개념이 없는 것이며 ready 로 취급하지 않는다.
 */
export const HELPER_STATES = ['pending', 'not-installed', 'disabled', 'unreachable', 'ready'] as const;
export type HelperState = (typeof HELPER_STATES)[number];

export interface HelperInfo {
  state: HelperState;
  /** ready 일 때 헬퍼 버전 */
  version?: string;
  /** ready 가 아닐 때 원인 */
  detail?: string;
}

/** `devices.list` 의 원소이자 `device.info` 의 결과. */
export interface DeviceInfo {
  id: string;
  platform: DevicePlatform;
  model: string;
  osVersion: string;
  state: DeviceConnectionState;
  /** unauthorized/offline 일 때 사용자에게 보여줄 원인 */
  stateDetail?: string;
  /** 기기가 Sinclair CA를 신뢰하는지. 프록시 모드 blocked 판정에 쓴다 */
  caTrusted?: boolean;
  /** 온디바이스 헬퍼 상태(Android). 연결 판정 뒤 온보딩이 끝나면 채워진다 */
  helper?: HelperInfo;
}

/** `device.io.*` 의 좌표 */
export interface Point { x: number; y: number }

// ---- 메서드별 파라미터 ----

export const DEVICE_BUTTONS = ['home', 'back', 'power', 'volume_up', 'volume_down'] as const;
export type DeviceButton = (typeof DEVICE_BUTTONS)[number];

export interface DeviceParams { deviceId: string }
export interface TapParams extends DeviceParams { x: number; y: number }
export interface LongPressParams extends TapParams { /** 기본 800 */ durationMs?: number }
/** 좌표 키는 camelCase (durationMs 와 같은 규칙) */
export interface SwipeParams extends DeviceParams { fromX: number; fromY: number; toX: number; toY: number; /** 기본 300 */ durationMs?: number }
export interface TextParams extends DeviceParams { text: string }
/** KEYCODE_* 상수 또는 숫자 키코드 */
export interface KeysParams extends DeviceParams { keys: string[] }
export interface ButtonParams extends DeviceParams { button: DeviceButton }
export interface AppParams extends DeviceParams { appId: string }
export interface UrlParams extends DeviceParams { url: string }

/** 메서드 → 파라미터. 목록에 있지만 아직 파라미터가 정해지지 않은 메서드는 포함하지 않는다. */
export interface DeviceRpcParams {
  'server.info': Record<string, never>;
  'devices.list': Record<string, never>;
  'device.info': DeviceParams;
  'device.screenshot': DeviceParams;
  'device.dump.ui': DeviceParams;
  'device.snapshot': DeviceParams;
  'device.io.tap': TapParams;
  'device.io.longpress': LongPressParams;
  'device.io.swipe': SwipeParams;
  'device.io.text': TextParams;
  'device.io.keys': KeysParams;
  'device.io.button': ButtonParams;
  'device.io.keyboard': DeviceParams;
  'device.apps.launch': AppParams;
  'device.apps.terminate': AppParams;
  'device.url': UrlParams;
}

/** `device.io.keyboard` 결과: 화면 키보드가 떠 있는가. null 이면 기기가 알려 주지 않음(모름) */
export interface KeyboardResult { shown: boolean | null }

/** `device.screenshot` 결과 */
export interface ScreenshotResult { format: 'png'; base64: string }

/**
 * `device.snapshot` 결과: 같은 순간의 스크린샷과 UI 트리. 녹화 캐시 재생의 앵커 검사가 "그 트리의 그 화면" 을 전제한다.
 * atomic 이 false 면 헬퍼가 원자 캡처를 못 해(Android 11 미만, takeScreenshot 간격 제한 등) 스크린샷을 screencap 으로 따로 찍은 것이다.
 */
export interface SnapshotResult {
  screenshot: ScreenshotResult;
  root: SemanticNode;
  atomic: boolean;
  /** ISO 8601, 호스트 기준 */
  capturedAt: string;
  /** atomic 이 false 인 이유 */
  detail?: string;
}
