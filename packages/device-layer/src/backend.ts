// 플랫폼 백엔드 인터페이스. Android/iOS/페이크가 이 계약을 구현하고, JSON-RPC 서버는 이것만 안다.
import type { DeviceButton, DeviceInfo, Point, SemanticNode } from '@sinclair/protocol';

// DeviceInfo/Point 는 와이어 계약이라 @sinclair/protocol 에 있다. 기존 import 호환을 위해 다시 내보낸다.
export type { DeviceInfo, Point } from '@sinclair/protocol';

export interface DeviceBackend {
  readonly platform: 'android' | 'ios';
  listDevices(): Promise<DeviceInfo[]>;
  info(deviceId: string): Promise<DeviceInfo>;
  screenshot(deviceId: string): Promise<Uint8Array>;
  /** 스크린샷과 같은 순간의 UI 트리. refs는 이 dump 안에서만 유효 */
  dumpUi(deviceId: string): Promise<SemanticNode>;
  tap(deviceId: string, p: Point): Promise<void>;
  longPress(deviceId: string, p: Point, durationMs: number): Promise<void>;
  swipe(deviceId: string, from: Point, to: Point, durationMs: number): Promise<void>;
  text(deviceId: string, text: string): Promise<void>;
  keys(deviceId: string, keys: string[]): Promise<void>;
  button(deviceId: string, name: DeviceButton): Promise<void>;
  launchApp(deviceId: string, appId: string): Promise<void>;
  terminateApp(deviceId: string, appId: string): Promise<void>;
  openUrl(deviceId: string, url: string): Promise<void>;
}
