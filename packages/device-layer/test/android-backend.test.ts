// @vitest-environment node
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAndroidBackend, parseScreenState, parseForegroundApp, type AndroidBackendOptions } from '../src/android/android-backend.ts';
import { createDeviceServer, RPC_ERRORS, type InputRouteEvent } from '../src/index.ts';
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

  it('keyboardShown 은 dumpsys input_method 의 mInputShown 을 읽는다(줄이 없으면 모름 = undefined)', async () => {
    const { backend, phone } = await ready();
    expect(await backend.keyboardShown!('PHONE1')).toBe(false);
    phone.keyboardShown = true;
    expect(await backend.keyboardShown!('PHONE1')).toBe(true);
    phone.keyboardShown = undefined;
    expect(await backend.keyboardShown!('PHONE1')).toBeUndefined();
  });

  it('input text 가 실패해도 오류 문구에 입력한 글자를 싣지 않는다(비밀번호일 수 있다)', async () => {
    const { backend, phone } = await ready();
    phone.failInput = 'Error: Invalid arguments';
    const err = (await backend.text('PHONE1', "Tr0ub 4dor'3").then(() => new Error('던지지 않음'), (e: unknown) => e as Error));
    expect(err.message).toMatch(/input text <입력값>/);
    expect(err.message).not.toMatch(/Tr0ub|4dor/);
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

  function helperSetup(prepare?: (phone: FakeAndroid, usb: FakeUsbDevice) => void, extra: number | Partial<AndroidBackendOptions> = 0) {
    const backoffMs = typeof extra === 'number' ? extra : 0;
    const more = typeof extra === 'number' ? {} : extra;
    const phone = new FakeAndroid();
    phone.installPackageName = phone.helper.pkg;
    const usbDevice = new FakeUsbDevice(phone.services, 'PHONE1');
    prepare?.(phone, usbDevice);
    const usb = new FakeUsbBackend([usbDevice]);
    const backend = createAndroidBackend({
      usbBackend: usb,
      helperApkPath: apkPath,
      helperRetryBackoffMs: backoffMs, // 복구 시나리오를 바로 보기 위해 기본 0. 백오프 테스트만 값을 준다
      helperActivate: { retries: 1 }, // 활성화 재시도는 기본 끔(실기기 동작은 전용 테스트에서 켠다)
      probeWaitMs: 5_000, // 온보딩이 끝난 뒤의 상태를 보기 위해 첫 판정을 충분히 기다린다
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
      ...more,
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
    const { backend, phone } = helperSetup(undefined, { helperFreshMs: 0 }); // 방금 성공한 요청이 있어도 재검사(아래 테스트가 기본 동작을 본다)
    await backend.listDevices();
    expect((await backend.info('PHONE1')).helper?.state).toBe('ready');
    phone.secureSettings.set('enabled_accessibility_services', '');
    phone.ignoreSettingsPut = true;
    expect((await backend.info('PHONE1')).helper?.state).toBe('disabled');
  });

  it('최근 헬퍼 요청이 성공했으면 device.info 는 /ping 을 보내지 않는다(Studio 스냅샷 폴링 중에도 데몬의 상태 보고가 헬퍼를 두드리지 않게)', async () => {
    const { backend, phone } = helperSetup();
    await backend.listDevices();
    await backend.dumpUi('PHONE1');
    const pings = phone.helper.requests.filter((r) => r === 'GET /ping').length;
    for (let i = 0; i < 3; i++) expect((await backend.info('PHONE1')).helper?.state).toBe('ready');
    expect(phone.helper.requests.filter((r) => r === 'GET /ping')).toHaveLength(pings);
  });

  it('/ping 이 한 번 실패해도(바쁨) 곧바로 다시 온보딩하지 않고 한 번 더 확인한다 — 실기에서 바쁜 헬퍼를 죽은 것으로 보고 57번 다시 온보딩했다', async () => {
    const { backend, phone } = helperSetup(undefined, { helperFreshMs: 0 });
    await backend.listDevices();
    const shells = phone.shellCommands.length;
    phone.helper.failPings = 1;
    expect((await backend.info('PHONE1')).helper?.state).toBe('ready');
    // 온보딩(설치 확인 pm path·접근성 settings·토큰 broadcast)이 돌지 않았다
    expect(phone.shellCommands.slice(shells).filter((c) => /pm path|settings|am broadcast/.test(c))).toEqual([]);
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

  it('막 설치한 서비스의 첫 settings put 이 무시돼도 재시도로 켜지고, 단계가 onHelperStep 으로 알려진다', async () => {
    const steps: string[] = [];
    const { backend, phone } = helperSetup((p) => { p.ignoreFirstAccessibilityPuts = 2; }, { helperActivate: { retries: 4, intervalMs: 5 }, onHelperStep: (_, t) => steps.push(t) });
    const [device] = await backend.listDevices();
    expect(device?.helper?.state).toBe('ready');
    expect(phone.secureSettings.get('enabled_accessibility_services')).toContain(phone.helper.service);
    expect(steps).toEqual([expect.stringMatching(/^헬퍼 설치 중/), '헬퍼 설치됨', '접근성 활성화 재시도 1/3', '접근성 활성화 재시도 2/3', '접근성 서비스 활성화됨', expect.stringMatching(/^헬퍼 준비됨/)]);
  });

  it('접근성 설정이 먹지 않으면(서비스 안 켜짐) helper 는 disabled 다', async () => {
    const { backend } = helperSetup((p) => { p.ignoreSettingsPut = true; }, { helperActivate: { retries: 2, intervalMs: 5 } });
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

describe('AndroidBackend 스냅샷 (device.snapshot) 과 screenshot 의 헬퍼 우선', () => {
  const apkPath = path.join(os.tmpdir(), `sinclair-fake-helper-snap-${process.pid}.apk`);
  beforeAll(() => fs.writeFileSync(apkPath, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 1)])));
  afterAll(() => fs.rmSync(apkPath, { force: true }));

  async function snapSetup(prepare?: (phone: FakeAndroid) => void) {
    const phone = new FakeAndroid();
    phone.installPackageName = phone.helper.pkg;
    prepare?.(phone);
    const usb = new FakeUsbBackend([new FakeUsbDevice(phone.services, 'PHONE1')]);
    const backend = createAndroidBackend({
      usbBackend: usb, helperApkPath: apkPath, helperRetryBackoffMs: 0, probeWaitMs: 5_000,
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    await backend.listDevices();
    phone.shellCommands.length = 0;
    return { phone, backend };
  }

  it('헬퍼가 원자 캡처를 지원하면 같은 응답에서 온 스크린샷과 트리를 atomic:true 로 돌려준다', async () => {
    const { phone, backend } = await snapSetup();
    const r = await backend.snapshot('PHONE1');
    expect(r.atomic).toBe(true);
    expect(r.screenshot).toEqual({ format: 'png', base64: phone.screenshotPng.toString('base64') });
    expect(r.root).toMatchObject({ ref: '@e0', children: [{ ref: '@e1', role: 'button' }] });
    expect(new Date(r.capturedAt).getTime()).toBeGreaterThan(0);
    expect(phone.shellCommands).not.toContain('screencap -p');
  });

  it('takeScreenshot 간격 제한으로 실패하면 트리는 그대로, 스크린샷은 screencap 으로 따로 찍고 atomic:false 와 이유를 준다', async () => {
    const { phone, backend } = await snapSetup((p) => { p.helper.screenshotRateLimited = true; });
    const r = await backend.snapshot('PHONE1');
    expect(r.atomic).toBe(false);
    expect(r.detail).toContain('간격');
    expect(r.screenshot.base64).toBe(phone.screenshotPng.toString('base64'));
    expect(phone.shellCommands).toContain('screencap -p');
  });

  it('Android 11 미만(API<30)이면 헬퍼가 스크린샷을 못 찍어 screencap 으로 fallback 한다', async () => {
    const { phone, backend } = await snapSetup((p) => { p.helper.sdk = 29; });
    const r = await backend.snapshot('PHONE1');
    expect(r.atomic).toBe(false);
    expect(r.detail).toMatch(/Android 11|API 30/);
    expect(phone.shellCommands).toContain('screencap -p');
  });

  it('screenshot 단독 호출도 헬퍼가 ready 면 헬퍼 경로를 쓰고, 아니면 screencap 을 쓴다', async () => {
    const { phone, backend } = await snapSetup();
    const png = await backend.screenshot('PHONE1');
    expect(Buffer.from(png).equals(phone.screenshotPng)).toBe(true);
    expect(phone.helper.requests).toContain('GET /snapshot');
    expect(phone.shellCommands).not.toContain('screencap -p');

    const off = await snapSetup((p) => { p.helper.sdk = 29; });
    await off.backend.screenshot('PHONE1');
    expect(off.phone.shellCommands).toContain('screencap -p');
  });

  it('헬퍼가 준비되지 않으면 snapshot 은 -32002 다(트리 없이 스크린샷만 줄 수는 없다)', async () => {
    const { backend } = await snapSetup((p) => { p.failInstall = 'INSTALL_FAILED_TEST_ONLY'; });
    await expect(backend.snapshot('PHONE1')).rejects.toMatchObject({ code: RPC_ERRORS.helperUnavailable });
  });

  it('JSON-RPC device.snapshot 이 결과를 그대로 노출한다', async () => {
    const { backend } = await snapSetup();
    const server = createDeviceServer([backend]);
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'device.snapshot', params: { deviceId: 'PHONE1' } });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ atomic: true, screenshot: { format: 'png' }, root: { ref: '@e0' } });
  });
});

describe('AndroidBackend 입력 경로 선택 (접근성 제스처 우선, shell fallback)', () => {
  const apkPath = path.join(os.tmpdir(), `sinclair-fake-helper-input-${process.pid}.apk`);
  beforeAll(() => fs.writeFileSync(apkPath, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 1)])));
  afterAll(() => fs.rmSync(apkPath, { force: true }));

  async function inputSetup(prepare?: (phone: FakeAndroid) => void, opts: { helper?: boolean; preferShellInput?: boolean } = {}) {
    const phone = new FakeAndroid();
    phone.installPackageName = phone.helper.pkg;
    prepare?.(phone);
    const usb = new FakeUsbBackend([new FakeUsbDevice(phone.services, 'PHONE1')]);
    const events: InputRouteEvent[] = [];
    const backend = createAndroidBackend({
      usbBackend: usb,
      helperApkPath: opts.helper === false ? MISSING_HELPER_APK : apkPath,
      helperRetryBackoffMs: 0, probeWaitMs: 5_000,
      ...(opts.preferShellInput ? { preferShellInput: true } : {}),
      onInput: (e) => events.push(e),
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    await backend.listDevices();
    phone.shellCommands.length = 0;
    return { phone, backend, events };
  }

  it('헬퍼가 ready 면 tap/longPress/swipe 는 접근성 제스처로 가고 shell input 은 호출되지 않는다', async () => {
    const { phone, backend, events } = await inputSetup();
    await backend.tap('PHONE1', { x: 10, y: 20 });
    await backend.longPress('PHONE1', { x: 5, y: 6 }, 800);
    await backend.swipe('PHONE1', { x: 0, y: 100 }, { x: 0, y: 10 }, 300);
    expect(phone.helper.gestures).toEqual(['tap 10,20', 'longpress 5,6 800', 'swipe 0,100->0,10 300']);
    expect(phone.shellCommands.filter((c) => c.startsWith('input '))).toEqual([]);
    expect(events.map((e) => `${e.action}:${e.route}`)).toEqual(['tap:helper', 'longPress:helper', 'swipe:helper']);
  });

  it('헬퍼가 제스처를 거부하면(취소) 같은 호출을 shell 로 한 번 재시도하고 이유를 남긴다', async () => {
    const { phone, backend, events } = await inputSetup((p) => { p.helper.refuseGestures = true; });
    await backend.tap('PHONE1', { x: 10, y: 20 });
    expect(phone.shellCommands).toContain('input tap 10 20');
    expect(events).toEqual([{ deviceId: 'PHONE1', action: 'tap', route: 'shell', fallback: { kind: 'refused', detail: expect.any(String) } }]);
  });

  it('헬퍼가 없으면(not-installed) shell 로 바로 가고 이유를 남긴다', async () => {
    const { phone, backend, events } = await inputSetup(undefined, { helper: false });
    await backend.tap('PHONE1', { x: 1, y: 2 });
    expect(phone.shellCommands).toContain('input tap 1 2');
    expect(events[0]).toMatchObject({ action: 'tap', route: 'shell', fallback: { kind: 'unavailable' } });
  });

  it('text 는 헬퍼 경로에서 setText 로 들어가 한글·이모지가 그대로 덧붙고, 헬퍼 경로가 안 될 때 비ASCII 는 -32602 다', async () => {
    const { phone, backend, events } = await inputSetup((p) => { p.helper.focusedText = '기존'; });
    await backend.text('PHONE1', ' 안녕 🙂');
    expect(phone.helper.focusedText).toBe('기존 안녕 🙂');
    expect(events[0]).toMatchObject({ action: 'text', route: 'helper' });

    const off = await inputSetup(undefined, { helper: false });
    await expect(off.backend.text('PHONE1', '안녕')).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await off.backend.text('PHONE1', 'ascii only');
    expect(off.phone.shellCommands).toContain("input text 'ascii%sonly'");
  });

  it('포커스된 입력 필드가 없으면 헬퍼가 409 를 주고 ASCII 텍스트는 shell 로 떨어진다', async () => {
    const { phone, backend, events } = await inputSetup((p) => { p.helper.focusedText = null; });
    await backend.text('PHONE1', 'hi');
    expect(phone.shellCommands).toContain("input text 'hi'");
    expect(events[0]).toMatchObject({ action: 'text', route: 'shell', fallback: { kind: 'refused' } });
  });

  it('preferShellInput 진단 옵션이면 헬퍼가 ready 여도 shell 경로를 쓴다', async () => {
    const { phone, backend, events } = await inputSetup(undefined, { preferShellInput: true });
    await backend.tap('PHONE1', { x: 3, y: 4 });
    expect(phone.helper.gestures).toEqual([]);
    expect(phone.shellCommands).toContain('input tap 3 4');
    expect(events[0]).toMatchObject({ action: 'tap', route: 'shell', fallback: { kind: 'preferred' } });
  });
});

describe('AndroidBackend 입력: 두 경로 모두 실패', () => {
  it('헬퍼가 거부한 뒤 shell 도 불가하면 오류에 두 이유가 모두 담기고 이벤트도 남는다', async () => {
    const apkPath = path.join(os.tmpdir(), `sinclair-fake-helper-both-${process.pid}.apk`);
    fs.writeFileSync(apkPath, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 1)]));
    cleanups.push(() => fs.rmSync(apkPath, { force: true }));
    const phone = new FakeAndroid();
    phone.installPackageName = phone.helper.pkg;
    phone.helper.focusedText = null; // 포커스된 입력 필드 없음 → 헬퍼 409
    const usb = new FakeUsbBackend([new FakeUsbDevice(phone.services, 'PHONE1')]);
    const events: InputRouteEvent[] = [];
    const backend = createAndroidBackend({
      usbBackend: usb, helperApkPath: apkPath, helperRetryBackoffMs: 0, probeWaitMs: 5_000, onInput: (e) => events.push(e),
      dadb: { keyPair: null, includeEmulators: false, usb: { idlePollMs: 20, claimRetries: 0 } },
    });
    cleanups.push(() => backend.close());
    await backend.listDevices();
    await expect(backend.text('PHONE1', '안녕')).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams, message: expect.stringMatching(/포커스.*ASCII|ASCII.*포커스/s) });
    expect(events).toEqual([{ deviceId: 'PHONE1', action: 'text', route: 'shell', fallback: { kind: 'refused', detail: expect.stringContaining('포커스') }, failed: expect.any(String) }]);
  });

  it('parseForegroundApp 은 dumpsys 의 resumed 액티비티·포커스 창 줄에서 패키지를 읽고, 못 읽으면 undefined', () => {
    expect(parseForegroundApp('  topResumedActivity=ActivityRecord{6a1f2c u0 com.google.android.apps.maps/com.google.android.maps.MapsActivity t1234}\n')).toBe('com.google.android.apps.maps');
    expect(parseForegroundApp('    mResumedActivity: ActivityRecord{3e2 u0 com.google.android.youtube/.HomeActivity t88}\n')).toBe('com.google.android.youtube');
    expect(parseForegroundApp('  mCurrentFocus=Window{9f0 u0 com.sec.android.app.launcher/com.sec.android.app.launcher.activities.LauncherActivity}\n')).toBe('com.sec.android.app.launcher');
    expect(parseForegroundApp('')).toBeUndefined();
    expect(parseForegroundApp('  mCurrentFocus=null\n')).toBeUndefined();
  });

  it('parseScreenState 는 dumpsys 출력에서 깨어 있음·잠금 여부를 읽고, 못 읽으면 필드를 비운다 (SM-N981N Android 13 실기기 출력 기준)', () => {
    expect(parseScreenState('  mWakefulness=Dozing\n', '    mShowingDream=false mDreamingLockscreen=true\n')).toEqual({ awake: false, locked: true });
    expect(parseScreenState('  mWakefulness=Awake\n', '    mDreamingLockscreen=false\n')).toEqual({ awake: true, locked: false });
    expect(parseScreenState('', 'isStatusBarKeyguard=true')).toEqual({ locked: true });
    expect(parseScreenState('sh: dumpsys: not found', '')).toEqual({});
  });
});
