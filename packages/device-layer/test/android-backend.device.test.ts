// @vitest-environment node
/**
 * 실기기 검증(opt-in): USB 로 꽂은 Android 기기가 AndroidBackend 의 devices.list 에 나온다.
 *
 *  1. 기기에서 USB 디버깅 켜기, 케이블 연결
 *  2. adb kill-server  (adb server 가 USB 인터페이스를 점유한다)
 *  3. SINCLAIR_TEST_USB=1 npx vitest run packages/device-layer/test/android-backend.device.test.ts
 *     (1 = 아무 기기, 또는 시리얼. 처음 보는 키면 기기에서 60초 안에 "USB 디버깅 허용")
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createAndroidBackend } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: 60_000 }, probeWaitMs: 60_000 });
afterAll(() => backend.close());

describe.skipIf(!target)('AndroidBackend 실기기', () => {
  it('꽂힌 기기가 device 상태로, 모델과 OS 버전과 함께 나온다', async () => {
    const devices = await backend.listDevices();
    const picked = target === '1' ? devices[0] : devices.find((d) => d.id === target);
    expect(picked, `USB ADB 기기를 찾지 못했습니다(SINCLAIR_TEST_USB=${target}). adb kill-server 와 케이블을 확인하세요. 목록: ${JSON.stringify(devices)}`).toBeDefined();
    expect(picked!.state, picked!.stateDetail).toBe('device');
    expect(picked!.model).not.toBe('');
    expect(picked!.osVersion).toMatch(/^\d/);
    expect((await backend.info(picked!.id)).id).toBe(picked!.id);
  }, 70_000);
});
