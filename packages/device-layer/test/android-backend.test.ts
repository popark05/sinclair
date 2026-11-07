// @vitest-environment node
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAndroidBackend } from '../src/android/android-backend.ts';
import { createDeviceServer, RPC_ERRORS } from '../src/index.ts';
import { FakeAndroid } from './adb/fake-android.ts';
import { FakeUsbBackend, FakeUsbDevice } from './adb/fake-usb.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 헬퍼 온보딩을 다루지 않는 테스트용: APK 가 없어 not-installed 로 끝난다. */
const MISSING_HELPER_APK = path.join(os.tmpdir(), 'sinclair-missing-helper.apk');

function setup(serial = 'PHONE1') {
  const phone = new FakeAndroid();
  const usbDevice = new FakeUsbDevice(phone.services, serial);
  const usb = new FakeUsbBackend([usbDevice]);
  const backend = createAndroidBackend({
    usbBackend: usb,
    helperApkPath: MISSING_HELPER_APK,
    // adb server 대체 경로는 꺼져 있다(기본값). 실제 5037에 닿지 않도록 에뮬레이터 탐색도 끈다.
    dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
  });
  cleanups.push(() => backend.close());
  return { phone, usbDevice, usb, backend };
}

describe('AndroidBackend.listDevices', () => {
  it('USB로 연결되고 승인된 기기는 device 상태로, 모델과 OS 버전과 함께 나온다', async () => {
    const { backend } = setup();
    const [device, ...rest] = await backend.listDevices();
    expect(rest).toEqual([]);
    expect(device).toMatchObject({ id: 'PHONE1', platform: 'android', model: 'Fake Pixel', osVersion: '14', state: 'device' });
    expect(['pending', 'not-installed']).toContain(device?.helper?.state);
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
      helperApkPath: MISSING_HELPER_APK,
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
    expect(list.result).toMatchObject([{ id: 'PHONE1', platform: 'android', model: 'Fake Pixel', osVersion: '14', state: 'device' }]);
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

describe('AndroidBackend 목록 캐시', () => {
  it('캐시 시간이 지나면 다음 listDevices 가 USB 를 다시 열거한다', async () => {
    const phone = new FakeAndroid();
    class CountingUsbBackend extends FakeUsbBackend {
      enumerations = 0;
      override async getDevices() { this.enumerations++; return super.getDevices(); }
    }
    const usb = new CountingUsbBackend([new FakeUsbDevice(phone.services, 'PHONE1')]);
    const backend = createAndroidBackend({
      usbBackend: usb,
      helperApkPath: MISSING_HELPER_APK,
      listCacheMs: 30,
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    await backend.listDevices();
    const after = usb.enumerations;
    await backend.listDevices();
    expect(usb.enumerations).toBe(after);
    await new Promise((r) => setTimeout(r, 40));
    await backend.listDevices();
    expect(usb.enumerations).toBe(after + 1);
  });
});

describe('AndroidBackend 입력 (adb shell input 경로)', () => {
  async function ready() {
    const s = setup();
    await s.backend.listDevices();
    s.phone.shellCommands.length = 0; // getprop 등 준비 호출은 제외
    return s;
  }

  it('tap/longPress/swipe 는 input tap/swipe 로 전달되고 호출 순서가 기록된다', async () => {
    const { backend, phone } = await ready();
    await backend.tap('PHONE1', { x: 10, y: 20 });
    await backend.longPress('PHONE1', { x: 5, y: 6 }, 800);
    await backend.swipe('PHONE1', { x: 0, y: 100 }, { x: 0, y: 10 }, 300);
    expect(phone.shellCommands).toEqual(['input tap 10 20', 'input swipe 5 6 5 6 800', 'input swipe 0 100 0 10 300']);
  });

  it('text 는 공백과 셸 특수문자를 깨지지 않게 이스케이프한다', async () => {
    const { backend, phone } = await ready();
    await backend.text('PHONE1', "hello world it's $HOME & \"q\" 50%");
    expect(phone.shellCommands).toEqual(["input text 'hello%sworld%sit'\\''s%s$HOME%s&%s\"q\"%s50%'"]);
  });

  it('비ASCII 텍스트(한글)는 input text 로 넣을 수 없으므로 명확한 오류로 거부한다', async () => {
    const { backend, phone } = await ready();
    await expect(backend.text('PHONE1', '안녕')).rejects.toThrow(/ASCII|헬퍼/);
    expect(phone.shellCommands).toEqual([]);
  });

  it('keys 와 button 은 input keyevent 로 전달된다', async () => {
    const { backend, phone } = await ready();
    await backend.keys('PHONE1', ['KEYCODE_ENTER', 'KEYCODE_TAB']);
    await backend.button('PHONE1', 'back');
    await backend.button('PHONE1', 'volume_up');
    expect(phone.shellCommands).toEqual(['input keyevent KEYCODE_ENTER KEYCODE_TAB', 'input keyevent KEYCODE_BACK', 'input keyevent KEYCODE_VOLUME_UP']);
  });

  it('input 이 실패(종료 코드 ≠ 0)하면 출력과 함께 오류가 난다', async () => {
    const { backend, phone } = await ready();
    phone.failInput = 'Error: Invalid arguments';
    await expect(backend.tap('PHONE1', { x: 1, y: 1 })).rejects.toThrow(/Invalid arguments/);
  });
});

describe('AndroidBackend 앱·URL·스크린샷 (adb shell 경로)', () => {
  async function ready() {
    const s = setup();
    await s.backend.listDevices();
    s.phone.shellCommands.length = 0;
    return s;
  }

  it('launchApp 은 런처 인텐트로 실행하고 terminateApp 은 force-stop 한다', async () => {
    const { backend, phone } = await ready();
    phone.packages.add('com.example.app');
    await backend.launchApp('PHONE1', 'com.example.app');
    await backend.terminateApp('PHONE1', 'com.example.app');
    expect(phone.shellCommands).toEqual([
      "monkey -p 'com.example.app' -c android.intent.category.LAUNCHER 1",
      "am force-stop 'com.example.app'",
    ]);
  });

  it('설치되지 않은 앱 실행은 monkey 출력으로 판정해 오류를 낸다', async () => {
    const { backend } = await ready();
    await expect(backend.launchApp('PHONE1', 'com.missing')).rejects.toThrow(/No activities found|com\.missing/);
  });

  it('openUrl 은 VIEW 인텐트로 열고, am 이 Error 를 출력하면(종료 코드 0이어도) 오류를 낸다', async () => {
    const { backend, phone } = await ready();
    await backend.openUrl('PHONE1', 'myapp://home?x=1&y=2');
    expect(phone.shellCommands).toEqual(["am start -W -a android.intent.action.VIEW -d 'myapp://home?x=1&y=2'"]);
    await expect(backend.openUrl('PHONE1', 'nothing://handles-this')).rejects.toThrow(/Error:/);
  });

  it('screenshot 은 screencap -p 의 바이트를 그대로(PNG 시그니처 포함) 돌려준다', async () => {
    const { backend, phone } = await ready();
    const png = await backend.screenshot('PHONE1');
    expect(Buffer.from(png.subarray(0, 8))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBe(phone.screenshotPng.length);
    expect(phone.shellCommands).toEqual(['screencap -p']);
  });
});

describe('AndroidBackend 셸 경로 안전성', () => {
  async function ready() {
    const s = setup();
    await s.backend.listDevices();
    s.phone.shellCommands.length = 0;
    return s;
  }

  it('keys 의 키 이름은 KEYCODE_* 또는 숫자만 허용해 셸 명령을 끼워 넣을 수 없다', async () => {
    const { backend, phone } = await ready();
    await expect(backend.keys('PHONE1', ['KEYCODE_A; reboot'])).rejects.toThrow(/키 이름/);
    await expect(backend.keys('PHONE1', ['$(id)'])).rejects.toThrow(/키 이름/);
    expect(phone.shellCommands).toEqual([]);
    await backend.keys('PHONE1', ['KEYCODE_ENTER', '66']);
    expect(phone.shellCommands).toEqual(['input keyevent KEYCODE_ENTER 66']);
  });

  it('screenshot 이 실패해도 셸 스트림을 닫는다(스트림 누수 없음)', async () => {
    const { backend, phone, usbDevice } = await ready();
    phone.failInput = 'screencap: permission denied';
    await expect(backend.screenshot('PHONE1')).rejects.toThrow(/permission denied/);
    await new Promise((r) => setTimeout(r, 30));
    expect(usbDevice.adb.streams.size).toBe(0);
  });
});

describe('AndroidBackend 헬퍼 온보딩과 device.dump.ui', () => {
  const apkPath = path.join(os.tmpdir(), `sinclair-fake-helper-${process.pid}.apk`);
  beforeAll(() => fs.writeFileSync(apkPath, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 1)])));
  afterAll(() => fs.rmSync(apkPath, { force: true }));

  function helperSetup(prepare?: (phone: FakeAndroid, usb: FakeUsbDevice) => void, backoffMs = 0) {
    const phone = new FakeAndroid();
    phone.installPackageName = phone.helper.pkg;
    const usbDevice = new FakeUsbDevice(phone.services, 'PHONE1');
    prepare?.(phone, usbDevice);
    const usb = new FakeUsbBackend([usbDevice]);
    const backend = createAndroidBackend({
      usbBackend: usb,
      helperApkPath: apkPath,
      helperRetryBackoffMs: backoffMs, // 복구 시나리오를 바로 보기 위해 기본 0. 백오프 테스트만 값을 준다
      probeWaitMs: 5_000, // 온보딩이 끝난 뒤의 상태를 보기 위해 첫 판정을 충분히 기다린다
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    return { phone, usbDevice, backend };
  }

  it('새 기기: 설치 → 접근성 활성화(--user 0) → 포워드 → 토큰 전달까지 자동으로 끝나고 helper 가 ready 다', async () => {
    const { backend, phone } = helperSetup();
    const [device] = await backend.listDevices();
    expect(device?.helper).toEqual({ state: 'ready', version: '0.1.0' });
    expect(phone.packages.has('io.sinclair.helper')).toBe(true);
    expect(phone.secureSettings.get('enabled_accessibility_services')).toContain(phone.helper.service);
    expect(phone.secureSettings.get('accessibility_enabled')).toBe('1');
    expect(phone.helper.token).toMatch(/^[0-9a-f]{32}$/);
    expect(phone.helper.requests).toContain('GET /ping');
  });

  it('연결 판정과 dump.ui 가 동시에 와도 온보딩은 한 번만 돈다(설치 1회, 터널 1개)', async () => {
    const { backend, phone } = helperSetup();
    const [, tree] = await Promise.all([backend.listDevices(), backend.dumpUi('PHONE1')]);
    expect(tree).toMatchObject({ ref: '@e0' });
    expect(phone.installs).toHaveLength(1);
    expect(phone.helper.requests.filter((r) => r === 'GET /ping')).toHaveLength(1);
  });

  it('서비스가 꺼지고 재활성화도 거부되면 dump.ui 없이 device.info 만으로도 disabled 가 드러난다(능동 재검사)', async () => {
    const { backend, phone } = helperSetup();
    await backend.listDevices();
    expect((await backend.info('PHONE1')).helper?.state).toBe('ready');
    phone.secureSettings.set('enabled_accessibility_services', '');
    phone.ignoreSettingsPut = true;
    expect((await backend.info('PHONE1')).helper?.state).toBe('disabled');
  });

  it('기기에 다른 토큰이 심겨 있으면(헬퍼 재시작 등) 재전송으로 복구하고, 재전송도 막히면 unreachable 이다', async () => {
    const { backend, phone } = helperSetup((p) => { p.helper.token = 'stale-token-from-another-session'; p.helper.dropToken = true; });
    const [device] = await backend.listDevices();
    expect(device?.helper?.state).toBe('unreachable');
    expect(device?.helper?.detail).toContain('401');
    phone.helper.dropToken = false;
    expect(await backend.dumpUi('PHONE1')).toMatchObject({ ref: '@e0' });
  });

  it('복구될 수 없는 상태에서는 매 호출마다 온보딩을 다시 돌리지 않는다(백오프)', async () => {
    const { backend, phone } = helperSetup((p) => { p.failInstall = 'INSTALL_FAILED_INSUFFICIENT_STORAGE'; }, 10_000);
    await backend.listDevices();
    const before = phone.installs.length;
    await expect(backend.dumpUi('PHONE1')).rejects.toMatchObject({ code: RPC_ERRORS.helperUnavailable });
    await expect(backend.dumpUi('PHONE1')).rejects.toMatchObject({ code: RPC_ERRORS.helperUnavailable });
    expect(phone.installs.length).toBe(before);
  });

  it('device.dump.ui 는 헬퍼의 /dump 트리(SemanticNode)를 돌려준다', async () => {
    const { backend } = helperSetup();
    await backend.listDevices();
    const tree = await backend.dumpUi('PHONE1');
    expect(tree).toMatchObject({ ref: '@e0', children: [{ ref: '@e1', role: 'button', name: '로그인' }] });
  });

  it('이미 설치·활성화된 기기는 다시 설치하지 않는다', async () => {
    const { backend, phone } = helperSetup((p) => {
      p.packages.add(p.helper.pkg);
      p.secureSettings.set('enabled_accessibility_services', p.helper.service);
      p.secureSettings.set('accessibility_enabled', '1');
    });
    const [device] = await backend.listDevices();
    expect(device?.helper?.state).toBe('ready');
    expect(phone.installs).toEqual([]);
  });

  it('설치가 실패하면 helper 는 not-installed 이고 원인이 detail 에 있다', async () => {
    const { backend } = helperSetup((p) => { p.failInstall = 'INSTALL_FAILED_INSUFFICIENT_STORAGE'; });
    const [device] = await backend.listDevices();
    expect(device?.helper?.state).toBe('not-installed');
    expect(device?.helper?.detail).toContain('INSUFFICIENT_STORAGE');
  });

  it('접근성 설정이 먹지 않으면(서비스 안 켜짐) helper 는 disabled 다', async () => {
    const { backend } = helperSetup((p) => { p.ignoreSettingsPut = true; });
    const [device] = await backend.listDevices();
    expect(device?.helper?.state).toBe('disabled');
    expect(device?.helper?.detail).toContain('접근성');
  });

  it('토큰이 기기에 전달되지 않으면 unreachable 이고, 전달되기 시작하면 다음 dump.ui 에서 재전송해 복구된다', async () => {
    const { backend, phone } = helperSetup((p) => { p.helper.dropToken = true; });
    const [device] = await backend.listDevices();
    expect(device?.helper?.state).toBe('unreachable');
    expect(device?.helper?.detail).toContain('401');
    phone.helper.dropToken = false;
    const tree = await backend.dumpUi('PHONE1');
    expect(tree).toMatchObject({ ref: '@e0' });
    expect((await backend.info('PHONE1')).helper?.state).toBe('ready');
  });

  it('서비스를 끄면 dump.ui 가 헬퍼 오류를 내고 info 가 disabled 로 바뀌며, 다시 켜면 복구된다', async () => {
    const { backend, phone } = helperSetup();
    await backend.listDevices();
    // 사용자가 설정에서 서비스를 끈 상황: 온보딩의 자동 재활성화도 거부되게 한다.
    phone.secureSettings.set('enabled_accessibility_services', '');
    phone.ignoreSettingsPut = true;
    await expect(backend.dumpUi('PHONE1')).rejects.toMatchObject({ code: RPC_ERRORS.helperUnavailable });
    expect((await backend.info('PHONE1')).helper?.state).toBe('disabled');
    phone.ignoreSettingsPut = false;
    phone.secureSettings.set('enabled_accessibility_services', phone.helper.service);
    expect(await backend.dumpUi('PHONE1')).toMatchObject({ ref: '@e0' });
    expect((await backend.info('PHONE1')).helper?.state).toBe('ready');
  });
});

describe('JSON-RPC device.dump.ui', () => {
  it('헬퍼가 준비되지 않은 기기는 -32002 와 원인을 돌려준다', async () => {
    const phone = new FakeAndroid();
    const usb = new FakeUsbBackend([new FakeUsbDevice(phone.services, 'PHONE1')]);
    const backend = createAndroidBackend({
      usbBackend: usb,
      helperApkPath: MISSING_HELPER_APK,
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    const server = createDeviceServer([backend]);
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'devices.list' });
    const r = await server.handle({ jsonrpc: '2.0', id: 2, method: 'device.dump.ui', params: { deviceId: 'PHONE1' } });
    expect(r.error?.code).toBe(RPC_ERRORS.helperUnavailable);
    expect(r.error?.message).toContain('not-installed');
  });
});
