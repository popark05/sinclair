// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { createAndroidBackend } from '../src/android/android-backend.ts';
import { createDeviceServer, RPC_ERRORS } from '../src/index.ts';
import { FakeAndroid } from './adb/fake-android.ts';
import { FakeUsbBackend, FakeUsbDevice } from './adb/fake-usb.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(serial = 'PHONE1') {
  const phone = new FakeAndroid();
  const usbDevice = new FakeUsbDevice(phone.services, serial);
  const usb = new FakeUsbBackend([usbDevice]);
  const backend = createAndroidBackend({
    usbBackend: usb,
    // adb server 대체 경로는 꺼져 있다(기본값). 실제 5037에 닿지 않도록 에뮬레이터 탐색도 끈다.
    dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
  });
  cleanups.push(() => backend.close());
  return { phone, usbDevice, usb, backend };
}

describe('AndroidBackend.listDevices', () => {
  it('USB로 연결되고 승인된 기기는 device 상태로, 모델과 OS 버전과 함께 나온다', async () => {
    const { backend } = setup();
    expect(await backend.listDevices()).toEqual([
      { id: 'PHONE1', platform: 'android', model: 'Fake Pixel', osVersion: '14', state: 'device' },
    ]);
  });
});

describe('AndroidBackend 상태 판정', () => {
  it('USB 인터페이스를 다른 프로세스가 점유하면 offline 이고 원인을 안내한다 (adb server 로 대체하지 않음)', async () => {
    const { backend, usbDevice } = setup();
    usbDevice.claimError = new Error('claimInterface error: Busy');
    const [device] = await backend.listDevices();
    expect(device?.state).toBe('offline');
    expect(device?.stateDetail).toContain('adb kill-server');
  });

  it('점유가 풀리면 다음 목록 갱신에서 device 로 복구된다', async () => {
    const { backend, usbDevice } = setup();
    backend.invalidate();
    usbDevice.claimError = new Error('claimInterface error: Busy');
    await backend.listDevices();
    usbDevice.claimError = undefined;
    backend.invalidate();
    const [device] = await backend.listDevices();
    expect(device?.state).toBe('device');
  });

  it('기기가 인증을 요구하는데 승인되지 않았으면 unauthorized 다', async () => {
    const { backend, usbDevice } = setup();
    usbDevice.adb.requireAuth = true;
    const [device] = await backend.listDevices();
    expect(device?.state).toBe('unauthorized');
    expect(device?.stateDetail).toContain('USB 디버깅 허용');
  });

  it('기기가 사라지면 목록에서 빠진다', async () => {
    const { backend, usb } = setup();
    await backend.listDevices();
    usb.devices = [];
    backend.invalidate();
    expect(await backend.listDevices()).toEqual([]);
  });
});

describe('AndroidBackend 과 JSON-RPC 서버', () => {
  /** USB 열거 횟수를 세는 백엔드. 디스패처의 기기 탐색이 호출마다 열거하면 실기기에서 느려진다. */
  class CountingUsbBackend extends FakeUsbBackend {
    enumerations = 0;
    override async getDevices() {
      this.enumerations++;
      return super.getDevices();
    }
  }

  function serverSetup() {
    const phone = new FakeAndroid();
    const usb = new CountingUsbBackend([new FakeUsbDevice(phone.services, 'PHONE1')]);
    const backend = createAndroidBackend({
      usbBackend: usb,
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    const server = createDeviceServer([backend]);
    const call = (method: string, params?: Record<string, unknown>) => server.handle({ jsonrpc: '2.0', id: 1, method, params });
    return { phone, usb, backend, server, call };
  }

  it('devices.list 와 device.info 가 실제 ADB 경로의 기기를 돌려준다', async () => {
    const { call } = serverSetup();
    const list = await call('devices.list');
    expect(list.result).toEqual([{ id: 'PHONE1', platform: 'android', model: 'Fake Pixel', osVersion: '14', state: 'device' }]);
    const info = await call('device.info', { deviceId: 'PHONE1' });
    expect((info.result as { model: string }).model).toBe('Fake Pixel');
  });

  it('연속된 기기 호출은 USB 를 다시 열거하지 않는다', async () => {
    const { call, usb } = serverSetup();
    await call('devices.list');
    const after = usb.enumerations; // 목록 1회 + 연결 시 기기 재탐색 1회
    for (let i = 0; i < 5; i++) await call('device.info', { deviceId: 'PHONE1' });
    await call('devices.list');
    expect(usb.enumerations).toBe(after);
  });

  it('없는 기기는 -32000 이다', async () => {
    const { call } = serverSetup();
    const r = await call('device.info', { deviceId: 'NOPE' });
    expect(r.error?.code).toBe(RPC_ERRORS.deviceNotFound);
  });
});
