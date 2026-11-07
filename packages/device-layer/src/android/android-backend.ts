// Android DeviceBackend: adb 바이너리 없이 직접 USB(src/adb)로 기기를 찾고 상태를 판정한다.
// 상태 판정 패턴은 EverMock의 direct-adb-adapter를 따른다.
import type { DeviceBackend, DeviceInfo, Point } from '../backend.ts';
import { Dadb, type DadbListOptions } from '../adb/dadb.ts';
import { AdbAuthException, AdbUsbAccessException } from '../adb/errors.ts';
import type { UsbBackend } from '../adb/transport/usb-discovery.ts';

/** 첫 목록 응답에서 연결 판정을 기다리는 시간. 넘으면 사용자 승인 대기(unauthorized)로 표시한다. */
const FIRST_PROBE_WAIT_MS = 1_500;
/** "USB 디버깅 허용" 승인을 기다리는 시간(연결 시도 1회). 실패하면 다음 목록 갱신에서 다시 시도한다. */
const AUTH_TIMEOUT_MS = 15_000;
/** 이 시간 안의 listDevices 재호출은 USB를 다시 열거하지 않는다(디스패처의 기기 탐색이 호출마다 부른다). */
const LIST_CACHE_MS = 2_000;

export interface AndroidBackendOptions {
  /** Dadb 옵션(테스트에서 가짜 키/타임아웃을 줄 때). */
  dadb?: DadbListOptions;
  /** USB 백엔드(테스트용). */
  usbBackend?: UsbBackend;
  /** 직접 USB/에뮬레이터 탐색을 건너뛰고 실행 중인 adb server만 쓴다(`SINCLAIR_ADB=server`, 진단용). */
  adbServerOnly?: boolean;
  /** 목록 캐시 유효 시간(ms). 기본 2초. */
  listCacheMs?: number;
  /** 첫 목록 응답에서 연결 판정을 기다리는 시간(ms). */
  probeWaitMs?: number;
}

interface Entry {
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
  const entries = new Map<string, Entry>();
  const dadbOptions: DadbListOptions = { authTimeoutMs: AUTH_TIMEOUT_MS, ...options.dadb };
  const listCacheMs = options.listCacheMs ?? LIST_CACHE_MS;
  const probeWaitMs = options.probeWaitMs ?? FIRST_PROBE_WAIT_MS;
  let lastList: { at: number; devices: DeviceInfo[] } | undefined;

  function classify(entry: Entry, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AdbAuthException) {
      entry.state = 'unauthorized';
      entry.detail = '기기 화면에서 "USB 디버깅 허용"을 승인하세요.';
    } else {
      entry.state = 'offline';
      entry.detail = error instanceof AdbUsbAccessException ? message : `연결 실패: ${message}`;
    }
  }

  async function readProps(entry: Entry): Promise<void> {
    if (entry.model !== undefined) return;
    const prop = async (key: string) => (await entry.dadb.shell(`getprop ${key}`)).output.trim();
    entry.model = await prop('ro.product.model');
    entry.osVersion = await prop('ro.build.version.release');
  }

  /** 연결 시도를 시작한다(이미 진행 중이면 그 시도를 반환). */
  function probe(entry: Entry): Promise<void> {
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

  function entryFor(serial: string, dadb?: Dadb): Entry {
    let entry = entries.get(serial);
    if (!entry) {
      const emulator = /^emulator-(\d+)$/.exec(serial);
      const created =
        dadb ??
        (options.adbServerOnly
          ? Dadb.fromAdbServer(serial, dadbOptions)
          : emulator
            ? Dadb.fromEmulator(Number(emulator[1]) + 1, dadbOptions)
            : Dadb.fromUsb(serial, { ...dadbOptions, ...(options.usbBackend ? { usbBackend: options.usbBackend } : {}) }));
      // 첫 판정 전에는 승인 대기로 본다(곧 연결 결과로 갱신된다).
      entry = { dadb: created, state: 'unauthorized' };
      entries.set(serial, entry);
    }
    return entry;
  }

  function toInfo(id: string, entry: Entry): DeviceInfo {
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
    const found = await Dadb.list({
      ...dadbOptions,
      ...(options.usbBackend ? { usbBackend: options.usbBackend } : {}),
      ...(options.adbServerOnly ? { includeUsb: false, includeEmulators: false, includeAdbServer: true } : {}),
    });
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

  const notImplemented = (name: string) => async (): Promise<never> => {
    throw new Error(`AndroidBackend.${name} 은 아직 구현되지 않았습니다`);
  };

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
      if (!found) throw new Error(`기기를 찾을 수 없음: ${deviceId}`);
      return found;
    },
    screenshot: notImplemented('screenshot'),
    dumpUi: notImplemented('dumpUi'),
    tap: notImplemented('tap') as (deviceId: string, p: Point) => Promise<void>,
    longPress: notImplemented('longPress'),
    swipe: notImplemented('swipe'),
    text: notImplemented('text'),
    keys: notImplemented('keys'),
    button: notImplemented('button'),
    launchApp: notImplemented('launchApp'),
    terminateApp: notImplemented('terminateApp'),
    openUrl: notImplemented('openUrl'),
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
