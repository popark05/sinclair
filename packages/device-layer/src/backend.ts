// 플랫폼 백엔드 인터페이스. Android/iOS/페이크가 이 계약을 구현하고, JSON-RPC 서버는 이것만 안다.
import type { SemanticNode } from '@sinclair/protocol';

export interface DeviceInfo {
  id: string;
  platform: 'android' | 'ios';
  model: string;
  osVersion: string;
  state: 'device' | 'unauthorized' | 'offline';
  /** unauthorized/offline 일 때 사용자에게 보여줄 원인 */
  stateDetail?: string;
  /** 기기가 Sinclair CA를 신뢰하는지. 프록시 모드 blocked 판정에 쓴다 */
  caTrusted?: boolean;
}

export interface Point { x: number; y: number }

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
  button(deviceId: string, name: 'home' | 'back' | 'power' | 'volume_up' | 'volume_down'): Promise<void>;
  launchApp(deviceId: string, appId: string): Promise<void>;
  terminateApp(deviceId: string, appId: string): Promise<void>;
  openUrl(deviceId: string, url: string): Promise<void>;
}
