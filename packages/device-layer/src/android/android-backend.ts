// Android DeviceBackend: adb 바이너리 없이 직접 USB(src/adb)로 기기를 찾고 상태를 판정한다.
// 상태 판정 패턴은 EverMock의 direct-adb-adapter를 따른다.
import type { DeviceButton } from '@sinclair/protocol';
import type { DeviceBackend, DeviceInfo } from '../backend.ts';
import { Dadb, type DadbListOptions } from '../adb/dadb.ts';
import { AdbAuthException, AdbUsbAccessException } from '../adb/errors.ts';
import type { UsbBackend } from '../adb/transport/usb-discovery.ts';
import { RpcError, RPC_ERRORS } from '../rpc.ts';

/** 첫 목록 응답에서 연결 판정을 기다리는 시간. 넘으면 사용자 승인 대기(unauthorized)로 표시한다. */
const FIRST_PROBE_WAIT_MS = 1_500;
/** "USB 디버깅 허용" 승인을 기다리는 시간(연결 시도 1회). 실패하면 다음 목록 갱신에서 다시 시도한다. */
const AUTH_TIMEOUT_MS = 15_000;
/** 이 시간 안의 listDevices 재호출은 USB를 다시 열거하지 않는다(디스패처의 기기 탐색이 호출마다 부른다). */
const LIST_CACHE_MS = 2_000;

/** `device.io.button` 이름 → Android 키코드 */
const BUTTON_KEYCODES: Record<DeviceButton, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
};

/** `input keyevent` 에 넘길 수 있는 키 이름: KEYCODE_* 상수 또는 숫자 키코드 */
const KEY_NAME = /^(KEYCODE_[A-Z0-9_]+|\d{1,4})$/;

/** 셸 인자 하나를 작은따옴표로 감싼다. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface AndroidBackendOptions {
  /** Dadb 옵션(테스트에서 가짜 키/타임아웃을 줄 때). */
  dadb?: DadbListOptions;
  /** USB 백엔드(테스트용). */
  usbBackend?: UsbBackend;
  /** 목록 캐시 유효 시간(ms). 기본 2초. */
  listCacheMs?: number;
  /** 첫 목록 응답에서 연결 판정을 기다리는 시간(ms). */
  probeWaitMs?: number;
}

/** 발견한 기기 하나의 연결과 판정 상태. */
interface TrackedDevice {
  dadb: Dadb;
  state: DeviceInfo['state'];
  detail?: string | undefined;
  model?: string | undefined;
  osVersion?: string | undefined;
  probe?: Promise<void> | undefined;
}

export interface AndroidBackend extends DeviceBackend {
  /** 목록 캐시를 버려 다음 listDevices 가 USB 를 다시 열거하게 한다. */
  invalidate(): void;
  /** 캐시한 연결을 모두 닫는다. */
  close(): Promise<void>;
}

export function createAndroidBackend(options: AndroidBackendOptions = {}): AndroidBackend {
  const entries = new Map<string, TrackedDevice>();
  const dadbOptions: DadbListOptions = { authTimeoutMs: AUTH_TIMEOUT_MS, ...options.dadb };
  const usbBackendOption = options.usbBackend ? { usbBackend: options.usbBackend } : {};
  const listCacheMs = options.listCacheMs ?? LIST_CACHE_MS;
  const probeWaitMs = options.probeWaitMs ?? FIRST_PROBE_WAIT_MS;
  let lastList: { at: number; devices: DeviceInfo[] } | undefined;

  function classify(entry: TrackedDevice, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AdbAuthException) {
      entry.state = 'unauthorized';
      entry.detail = '기기 화면에서 "USB 디버깅 허용"을 승인하세요.';
    } else {
      entry.state = 'offline';
      entry.detail = error instanceof AdbUsbAccessException ? message : `연결 실패: ${message}`;
    }
  }

  async function readProps(entry: TrackedDevice): Promise<void> {
    if (entry.model !== undefined) return;
    const prop = async (key: string) => (await entry.dadb.shell(`getprop ${key}`)).output.trim();
    entry.model = await prop('ro.product.model');
    entry.osVersion = await prop('ro.build.version.release');
  }

  /** 연결 시도를 시작한다(이미 진행 중이면 그 시도를 반환). */
  function probe(entry: TrackedDevice): Promise<void> {
    if (!entry.probe) {
      entry.probe = entry.dadb
        .connect()
        .then(() => readProps(entry))
        .then(() => {
          entry.state = 'device';
          entry.detail = undefined;
        })
        .catch((e) => classify(entry, e))
        .finally(() => {
          entry.probe = undefined;
        });
    }
    return entry.probe;
  }

  function entryFor(serial: string, dadb?: Dadb): TrackedDevice {
    let entry = entries.get(serial);
    if (!entry) {
      const emulator = /^emulator-(\d+)$/.exec(serial);
      const created =
        dadb ??
        (emulator
          ? Dadb.fromEmulator(Number(emulator[1]) + 1, dadbOptions)
          : Dadb.fromUsb(serial, { ...dadbOptions, ...usbBackendOption }));
      // 첫 판정 전에는 승인 대기로 본다(곧 연결 결과로 갱신된다).
      entry = { dadb: created, state: 'unauthorized' };
      entries.set(serial, entry);
    }
    return entry;
  }

  function toInfo(id: string, entry: TrackedDevice): DeviceInfo {
    return {
      id,
      platform: 'android',
      model: entry.model ?? '',
      osVersion: entry.osVersion ?? '',
      state: entry.state,
      ...(entry.detail === undefined ? {} : { stateDetail: entry.detail }),
    };
  }

  async function refresh(): Promise<DeviceInfo[]> {
    const found = await Dadb.list({ ...dadbOptions, ...usbBackendOption });
    const serials = new Set(found.map((d) => d.serial));
    for (const [serial, entry] of entries) {
      if (!serials.has(serial)) {
        entries.delete(serial);
        void entry.dadb.close();
      }
    }
    for (const dadb of found) entryFor(dadb.serial, dadb);

    const pending: Promise<void>[] = [];
    for (const entry of entries.values()) {
      if (entry.dadb.connectionKind) {
        entry.state = 'device';
        entry.detail = undefined;
      } else {
        pending.push(probe(entry));
      }
    }
    // 빠르게 끝나는 연결(이미 승인된 기기)은 이번 응답에 반영하고, 승인 대기는 기다리지 않는다.
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, probeWaitMs))]);

    const devices = [...entries.entries()].map(([id, entry]) => toInfo(id, entry));
    lastList = { at: Date.now(), devices };
    return devices;
  }

  const notImplemented = (name: string) => async (..._args: unknown[]): Promise<never> => {
    throw new Error(`AndroidBackend.${name} 은 아직 구현되지 않았습니다`);
  };

  function dadbFor(deviceId: string): Dadb {
    const entry = entries.get(deviceId);
    if (!entry) throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${deviceId}`);
    return entry.dadb;
  }

  /** 셸 명령을 실행하고 종료 코드가 0이 아니면 출력을 담아 던진다. */
  async function run(deviceId: string, command: string): Promise<string> {
    const r = await dadbFor(deviceId).shell(command);
    if (r.exitCode !== 0) throw new Error(`셸 명령 실패(exit ${r.exitCode}): ${command}\n${r.allOutput.trim()}`);
    return r.allOutput;
  }

  const runVoid = (deviceId: string, command: string) => run(deviceId, command).then(() => undefined);
  const input = (deviceId: string, args: string) => runVoid(deviceId, `input ${args}`);

  /** am/monkey 는 실패해도 종료 코드 0 으로 "Error: ..." 만 출력하는 경우가 있어 출력으로도 판정한다. */
  async function runActivityManager(deviceId: string, command: string): Promise<void> {
    const out = await run(deviceId, command);
    const error = /^(Error:.*|\*\* No activities found.*)$/m.exec(out);
    if (error) throw new Error(`앱 실행 실패: ${error[0]}`);
  }

  /** 바이너리 출력을 내는 명령. shell() 은 utf-8 로 디코딩하므로 패킷을 직접 모은다. */
  async function runBinary(deviceId: string, command: string): Promise<Uint8Array> {
    const stream = await dadbFor(deviceId).openShell(command);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    try {
      for (;;) {
        const packet = await stream.read();
        if (packet.type === 'exit') {
          if (packet.exitCode !== 0) throw new Error(`셸 명령 실패(exit ${packet.exitCode}): ${command}\n${Buffer.concat(err).toString('utf-8').trim()}`);
          return Buffer.concat(out);
        }
        (packet.type === 'stdout' ? out : err).push(packet.payload);
      }
    } finally {
      await stream.close();
    }
  }

  return {
    platform: 'android',
    async listDevices(): Promise<DeviceInfo[]> {
      if (lastList && Date.now() - lastList.at < listCacheMs) return lastList.devices;
      return refresh();
    },
    async info(deviceId: string): Promise<DeviceInfo> {
      const entry = entries.get(deviceId);
      if (entry) return toInfo(deviceId, entry);
      const found = (await refresh()).find((d) => d.id === deviceId);
      if (!found) throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${deviceId}`);
      return found;
    },
    screenshot: (id) => runBinary(id, 'screencap -p'),
    dumpUi: notImplemented('dumpUi'),
    tap: (id, p) => input(id, `tap ${p.x} ${p.y}`),
    longPress: (id, p, durationMs) => input(id, `swipe ${p.x} ${p.y} ${p.x} ${p.y} ${durationMs}`),
    swipe: (id, from, to, durationMs) => input(id, `swipe ${from.x} ${from.y} ${to.x} ${to.y} ${durationMs}`),
    text: async (id, text) => {
      // `input text` 는 ASCII 만 받는다(비ASCII 는 기기에서 무시되거나 깨진다). 한글 등은 접근성 헬퍼 경로(setText)가 맡는다.
      // 알려진 한계: `input text` 는 `%s` 를 공백으로 해석하므로 리터럴 "%s" 는 전달할 수 없다(이스케이프 수단 없음).
      if (!/^[\x20-\x7e]*$/.test(text)) {
        throw new RpcError(RPC_ERRORS.invalidParams, 'input text 는 ASCII 만 지원합니다. 비ASCII 텍스트는 접근성 헬퍼가 필요합니다');
      }
      return input(id, `text ${shellQuote(text.replace(/ /g, '%s'))}`);
    },
    keys: async (id, keys) => {
      // 키 이름은 인용 없이 보간되므로 화이트리스트로만 허용한다(셸 명령 삽입 방지).
      const bad = keys.find((k) => !KEY_NAME.test(k));
      if (bad !== undefined) throw new RpcError(RPC_ERRORS.invalidParams, `허용되지 않는 키 이름: ${bad} (KEYCODE_* 또는 숫자 키코드만)`);
      return input(id, `keyevent ${keys.join(' ')}`);
    },
    button: (id, name) => input(id, `keyevent ${BUTTON_KEYCODES[name]}`),
    // appId 만 받으므로 액티비티 이름이 필요한 `am start -n` 대신 런처 카테고리로 여는 monkey 를 쓴다.
    launchApp: (id, appId) => runActivityManager(id, `monkey -p ${shellQuote(appId)} -c android.intent.category.LAUNCHER 1`),
    terminateApp: (id, appId) => runVoid(id, `am force-stop ${shellQuote(appId)}`),
    openUrl: (id, url) => runActivityManager(id, `am start -W -a android.intent.action.VIEW -d ${shellQuote(url)}`),
    invalidate(): void {
      lastList = undefined;
    },
    async close(): Promise<void> {
      const all = [...entries.values()];
      entries.clear();
      lastList = undefined;
      await Promise.allSettled(all.map((e) => e.dadb.close()));
    },
  };
}
