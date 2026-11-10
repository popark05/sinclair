// 플랫폼 백엔드 인터페이스. Android/iOS/페이크가 이 계약을 구현하고, JSON-RPC 서버는 이것만 안다.
import type { DeviceButton, DeviceInfo, Point, SemanticNode, SnapshotResult } from '@sinclair/protocol';

// DeviceInfo/Point 는 와이어 계약이라 @sinclair/protocol 에 있다. 기존 import 호환을 위해 다시 내보낸다.
export type { DeviceInfo, Point } from '@sinclair/protocol';

export interface ScreenState { awake?: boolean; locked?: boolean }

export interface DeviceBackend {
  readonly platform: 'android' | 'ios';
  listDevices(): Promise<DeviceInfo[]>;
  info(deviceId: string): Promise<DeviceInfo>;
  screenshot(deviceId: string): Promise<Uint8Array>;
  /** 스크린샷과 같은 순간의 UI 트리. refs는 이 dump 안에서만 유효 */
  dumpUi(deviceId: string): Promise<SemanticNode>;
  /** 같은 순간의 스크린샷과 UI 트리. 원자 캡처가 불가하면 atomic:false 로 따로 찍은 것을 돌려준다 */
  snapshot(deviceId: string): Promise<SnapshotResult>;
  tap(deviceId: string, p: Point): Promise<void>;
  longPress(deviceId: string, p: Point, durationMs: number): Promise<void>;
  swipe(deviceId: string, from: Point, to: Point, durationMs: number): Promise<void>;
  text(deviceId: string, text: string): Promise<void>;
  keys(deviceId: string, keys: string[]): Promise<void>;
  button(deviceId: string, name: DeviceButton): Promise<void>;
  /** 화면 키보드가 떠 있는가(선택). 알 수 없으면 undefined */
  keyboardShown?(deviceId: string): Promise<boolean | undefined>;
  /** 화면 상태(선택). 알 수 없으면 필드가 비어 있다. 잠금화면 위에서는 앱 창이 안 보여 모든 locator 가 실패하므로 러너가 미리 확인한다 */
  screenState?(deviceId: string): Promise<ScreenState>;
  launchApp(deviceId: string, appId: string): Promise<void>;
  terminateApp(deviceId: string, appId: string): Promise<void>;
  openUrl(deviceId: string, url: string): Promise<void>;
}
