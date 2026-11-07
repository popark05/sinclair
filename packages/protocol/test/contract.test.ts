// 계약 테스트: 상수 목록과 타입이 어긋나지 않는지, 명명 규칙이 지켜지는지 고정한다.
import { describe, it, expect } from 'vitest';
import {
  RUN_EVENT_TYPES, DEVICE_RPC_METHODS, ATTEMPT_RESULTS, CACHE_DECISIONS, NETWORK_MODES,
  capabilitiesOf, type Engine, type RunEvent,
  DEVICE_CONNECTION_STATES, DEVICE_PLATFORMS, DEVICE_BUTTONS, HELPER_STATES, type DeviceInfo, type DeviceRpcParams, type SnapshotResult,
} from '../src/index.ts';

describe('protocol 계약', () => {
  it('이벤트 타입 목록은 중복이 없고 "<entity>.<verb>" 형식이다', () => {
    expect(new Set(RUN_EVENT_TYPES).size).toBe(RUN_EVENT_TYPES.length);
    for (const t of RUN_EVENT_TYPES) expect(t).toMatch(/^(run|attempt|step)\.[a-z]+$/);
  });

  it('디바이스 RPC 메서드는 중복이 없고 device.* 또는 devices.list, server.* 이다', () => {
    expect(new Set(DEVICE_RPC_METHODS).size).toBe(DEVICE_RPC_METHODS.length);
    for (const m of DEVICE_RPC_METHODS) expect(m).toMatch(/^(device\.[a-z.]+|devices\.list|server\.[a-z]+)$/);
  });

  it('상태 상수는 spec의 값과 일치한다', () => {
    expect(ATTEMPT_RESULTS).toEqual(['passed', 'failed', 'blocked', 'skipped']);
    expect(CACHE_DECISIONS).toEqual(['replayed', 'handed-off', 'recorded', 'live']);
    expect(NETWORK_MODES).toEqual(['direct', 'capture', 'mock']);
  });

  it('capability는 구현된 선택 메서드로만 결정된다', () => {
    const base: Engine = {
      name: 'fake', spiVersion: 1, actions: ['tap'],
      observe: async () => ({ root: { ref: '@e0', role: 'root' } }),
      locate: async () => [],
      perform: async () => {},
    };
    expect(capabilitiesOf(base)).toEqual([]);
    expect(capabilitiesOf({ ...base, performAt: async () => {} })).toEqual(['pointer']);
  });

  it('run.started 는 targetId 만 필수이고 cycleId/deviceId 는 선택이다 (로컬 실행에는 Cycle 이 없다)', () => {
    const local: RunEvent = { schema: 1, eventId: 'e0', runId: 'r1', at: '2026-11-07T00:00:00Z', type: 'run.started', targetId: 'fake' };
    expect(local.type).toBe('run.started');
    expect('cycleId' in local).toBe(false);
  });

  it('attempt.finished 이벤트는 result 필드가 필수다', () => {
    const ev: RunEvent = {
      schema: 1, eventId: 'e1', runId: 'r1', at: '2026-11-07T00:00:00Z',
      type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [],
    };
    expect(ev.type).toBe('attempt.finished');
  });
});

describe('디바이스 RPC 응답 계약', () => {
  it('devices.list 원소(DeviceInfo)는 id/platform/model/osVersion/state 가 필수이고 stateDetail/caTrusted 는 선택이다', () => {
    // 스펙의 예시 응답. 필드가 빠지거나 이름이 바뀌면 여기서 컴파일 오류가 난다.
    const minimal: DeviceInfo = { id: 'R3CX', platform: 'android', model: 'SM-F936N', osVersion: '14', state: 'device' };
    const blocked: DeviceInfo = { ...minimal, state: 'unauthorized', stateDetail: '기기 화면에서 "USB 디버깅 허용"을 승인하세요.' };
    expect(Object.keys(minimal).sort()).toEqual(['id', 'model', 'osVersion', 'platform', 'state']);
    expect(blocked.stateDetail).toContain('USB 디버깅 허용');
  });

  it('연결 상태와 플랫폼 상수는 spec 의 값과 일치한다', () => {
    expect(DEVICE_CONNECTION_STATES).toEqual(['device', 'unauthorized', 'offline']);
    expect(DEVICE_PLATFORMS).toEqual(['android', 'ios']);
  });
});

describe('디바이스 RPC 파라미터 계약', () => {
  it('좌표 파라미터는 x/y, 스와이프는 fromX/fromY/toX/toY camelCase 이며 durationMs 는 선택이다', () => {
    const tap: DeviceRpcParams['device.io.tap'] = { deviceId: 'D', x: 1, y: 2 };
    const swipe: DeviceRpcParams['device.io.swipe'] = { deviceId: 'D', fromX: 0, fromY: 100, toX: 0, toY: 10 };
    const withDuration: DeviceRpcParams['device.io.swipe'] = { ...swipe, durationMs: 300 };
    expect(Object.keys(tap).sort()).toEqual(['deviceId', 'x', 'y']);
    expect(Object.keys(swipe).sort()).toEqual(['deviceId', 'fromX', 'fromY', 'toX', 'toY']);
    expect(withDuration.durationMs).toBe(300);
  });

  it('하드웨어 버튼 이름 목록은 spec 의 값과 일치하고, 기기 호출 파라미터는 모두 deviceId 를 가진다', () => {
    expect(DEVICE_BUTTONS).toEqual(['home', 'back', 'power', 'volume_up', 'volume_down']);
    const keys: DeviceRpcParams['device.io.keys'] = { deviceId: 'D', keys: ['KEYCODE_ENTER'] };
    const launch: DeviceRpcParams['device.apps.launch'] = { deviceId: 'D', appId: 'com.example' };
    const url: DeviceRpcParams['device.url'] = { deviceId: 'D', url: 'myapp://home' };
    for (const p of [keys, launch, url]) expect(p.deviceId).toBe('D');
  });
});

describe('DeviceInfo.helper 계약 (온디바이스 헬퍼 상태)', () => {
  it('헬퍼 상태는 not-installed/disabled/unreachable/ready 이고 ready 가 아니면 detail 로 원인을 준다', () => {
    // pending: 온보딩이 아직 끝나지 않음. 러너는 ready 외의 모든 값(없음 포함)을 "사용 불가" 로 본다.
    expect(HELPER_STATES).toEqual(['pending', 'not-installed', 'disabled', 'unreachable', 'ready']);
    const ready: DeviceInfo = { id: 'D', platform: 'android', model: 'M', osVersion: '14', state: 'device', helper: { state: 'ready', version: '0.1.0' } };
    const off: DeviceInfo = { ...ready, helper: { state: 'disabled', detail: '접근성 서비스가 꺼져 있음' } };
    expect(ready.helper?.state).toBe('ready');
    expect(off.helper?.detail).toContain('접근성');
  });
});

describe('device.snapshot 계약 (스크린샷·트리 원자 캡처)', () => {
  it('메서드 목록에 있고, 결과는 screenshot/root/atomic/capturedAt 을 가지며 원자성이 깨지면 detail 로 이유를 준다', () => {
    expect(DEVICE_RPC_METHODS).toContain('device.snapshot');
    const atomic: SnapshotResult = {
      screenshot: { format: 'png', base64: 'iVBORw0KGgo=' },
      root: { ref: '@e0', role: 'group' },
      atomic: true,
      capturedAt: '2026-11-07T00:00:00.000Z',
    };
    const fallback: SnapshotResult = { ...atomic, atomic: false, detail: 'takeScreenshot 호출 간격 제한' };
    expect(Object.keys(atomic).sort()).toEqual(['atomic', 'capturedAt', 'root', 'screenshot']);
    expect(fallback.detail).toBeDefined();
    const p: DeviceRpcParams['device.snapshot'] = { deviceId: 'D' };
    expect(p.deviceId).toBe('D');
  });
});

describe('Engine.observe 옵션 계약', () => {
  it('observe 는 기본적으로 트리만 주고, pixels 를 요청했을 때만 pixels 와 atomic 여부를 준다', async () => {
    const engine: Engine = {
      name: 'fake', spiVersion: 1, actions: ['tap'],
      observe: async (options) => options?.pixels
        ? { root: { ref: '@e0', role: 'root' }, pixels: new Uint8Array([0x89]), atomic: true }
        : { root: { ref: '@e0', role: 'root' } },
      locate: async () => [],
      perform: async () => {},
    };
    const plain = await engine.observe();
    expect(plain.pixels).toBeUndefined();
    const withPixels = await engine.observe({ pixels: true });
    expect(withPixels.pixels?.length).toBe(1);
    expect(withPixels.atomic).toBe(true);
  });
});
