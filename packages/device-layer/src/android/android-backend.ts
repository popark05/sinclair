// Android DeviceBackend: adb 바이너리 없이 직접 USB(src/adb)로 기기를 찾고 상태를 판정한다.
// 상태 판정 패턴은 EverMock의 direct-adb-adapter를 따른다.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DeviceButton, HelperInfo, SemanticNode, SnapshotResult } from '@sinclair/protocol';
import type { DeviceBackend, ScreenState, DeviceInfo } from '../backend.ts';
import { HELPER_PACKAGE, HELPER_SERVICE, HelperHttpError, HelperSession, type HelperAction } from './helper-client.ts';
import { ADB_TRACE, adbTrace } from '../adb/trace.ts';
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
/** 접근성 서비스를 켠 뒤 헬퍼 HTTP 서버가 뜨기까지 기다리는 상한. 실기기에서 보통 1~3초. */
const HELPER_START_TIMEOUT_MS = 8_000;
/** /ping 재시도 간격. 서비스 기동(1~3초)을 놓치지 않을 만큼 짧고 기기를 괴롭히지 않을 만큼 길다. */
const HELPER_POLL_MS = 250;
/** 온보딩이 실패한 뒤 같은 기기에 다시 시도하기까지의 간격. 영구 실패(저장소 부족 등)로 호출마다 8초씩 막히는 것을 막는다. */
const HELPER_RETRY_BACKOFF_MS = 10_000;
/** 재검사: 이 안에 성공한 헬퍼 요청이 있으면 ping 하지 않는다(데몬 상태 보고 20초 간격보다 짧게 — 놀고 있는 기기는 매 보고마다 확인된다) */
const HELPER_FRESH_MS = 15_000;
/** 재검사 ping 이 실패하면 이만큼 뒤 한 번 더 */
const HELPER_RECHECK_RETRY_MS = 500;
/** 막 설치한 직후에는 접근성 관리자가 아직 모르는 서비스를 enabled 목록에서 지워 버려 첫 `settings put` 이 무시된다(실기기 SM-N981N 에서 확인).
 *  1초 간격으로 몇 번 다시 쓴다. */
const ACTIVATE_RETRY_MS = 1_000;
const ACTIVATE_RETRIES = 5;
/** 리포 안에서 빌드한 헬퍼 APK(android-helper README 의 빌드 절차). 개발 전용 — 설치본은 helperApkPath 를 넘긴다.
 *  번들에서는 이 상대 경로가 존재하지 않는 곳을 가리켜 자연히 "APK 없음" 이 된다(앱 빌드 설정을 알 필요 없음) */
function devHelperApk(): string | undefined {
  try { return fileURLToPath(new URL('../../android-helper/app/build/outputs/apk/debug/app-debug.apk', import.meta.url)); } catch { return undefined; }
}

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

/** `dumpsys power`/`dumpsys window` 출력에서 화면 상태를 읽는다. 못 읽으면 필드를 비운다(기기·버전마다 문구가 다를 수 있다) */
export function parseScreenState(power: string, window: string): ScreenState {
  const wake = /mWakefulness=(\w+)/.exec(power)?.[1];
  const lock = /mDreamingLockscreen=(true|false)/.exec(window)?.[1] ?? /isStatusBarKeyguard=(true|false)/.exec(window)?.[1];
  return { ...(wake ? { awake: wake === 'Awake' } : {}), ...(lock ? { locked: lock === 'true' } : {}) };
}

/** dumpsys 의 resumed 액티비티(`topResumedActivity=`/`mResumedActivity:`) 또는 포커스 창(`mCurrentFocus=`) 줄에서 패키지를 읽는다. 못 읽으면 undefined */
export function parseForegroundApp(out: string): string | undefined {
  return /\bu\d+\s+([A-Za-z][\w.]*)\//.exec(out)?.[1];
}

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
  /** 기기에 설치할 헬퍼 APK 경로. 기본은 리포 안 디버그 빌드. */
  helperApkPath?: string;
  /** 온보딩 실패 뒤 재시도 간격(ms). 기본 10초. */
  helperRetryBackoffMs?: number;
  /** 이 안에 성공한 헬퍼 요청이 있으면 재검사 ping 을 생략(ms). 기본 15초. 0 이면 늘 확인 */
  helperFreshMs?: number;
  /** 접근성 활성화 재시도(기본 5회, 1초 간격). 테스트에서 줄인다. */
  helperActivate?: { retries?: number; intervalMs?: number };
  /** 온보딩 단계 알림(설치·활성화 시도·준비). 에이전트가 로그·증거로 남긴다. */
  onHelperStep?: (deviceId: string, step: string) => void;
  /** 진단용: 헬퍼가 준비돼 있어도 입력을 `adb shell input` 경로로 보낸다(두 경로 비교·헬퍼 없는 상황 재현). */
  preferShellInput?: boolean;
  /** 입력 한 건이 어느 경로로 갔는지 알린다(로그·테스트). */
  onInput?: (event: InputRouteEvent) => void;
}

/** 입력이 실제로 탄 경로. shell 이면 fallback 에 헬퍼를 못 쓴 이유가 있다. */
export interface InputRouteEvent {
  deviceId: string;
  action: 'tap' | 'longPress' | 'swipe' | 'text';
  route: 'helper' | 'shell';
  /** refused: 헬퍼가 거부(제스처 취소, 포커스 없음) / unavailable: 헬퍼 미준비·호출 실패 / preferred: preferShellInput 옵션 */
  fallback?: { kind: 'refused' | 'unavailable' | 'preferred'; detail: string };
  /** shell 경로마저 실패했을 때 그 오류 메시지. 호출자에게는 두 이유를 합친 오류가 던져진다 */
  failed?: string;
}

/** 발견한 기기 하나의 연결과 판정 상태. */
interface TrackedDevice {
  dadb: Dadb;
  state: DeviceInfo['state'];
  detail?: string | undefined;
  model?: string | undefined;
  osVersion?: string | undefined;
  probe?: Promise<void> | undefined;
  helper?: HelperInfo | undefined;
  session?: HelperSession | undefined;
  /** 진행 중인 온보딩(중복 실행 방지: probe 와 dumpUi 가 동시에 부를 수 있다). */
  onboarding?: Promise<void> | undefined;
  /** 마지막 온보딩 실패 시각(백오프 기준). */
  helperFailedAt?: number | undefined;
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
  const helperRetryBackoffMs = options.helperRetryBackoffMs ?? HELPER_RETRY_BACKOFF_MS;
  const helperFreshMs = options.helperFreshMs ?? HELPER_FRESH_MS;
  let lastList: { at: number; devices: DeviceInfo[] } | undefined;
  /** 진행 중인 USB 열거(동시 listDevices/dumpUi 가 열거를 겹치지 않게). */
  let refreshing: Promise<DeviceInfo[]> | undefined;

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
        // 연결 판정 직후 헬퍼 온보딩. 실패는 helper 상태로 드러내고 연결 상태에는 영향을 주지 않는다.
        .then(() => ensureHelper(entry))
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
      // 첫 판정 전에는 승인 대기로 본다(곧 연결 결과로 갱신된다). 헬퍼는 온보딩 전이므로 pending.
      entry = { dadb: created, state: 'unauthorized', helper: { state: 'pending' } };
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
      ...(entry.helper === undefined ? {} : { helper: entry.helper }),
    };
  }

  function refresh(): Promise<DeviceInfo[]> {
    refreshing ??= refreshNow().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  async function refreshNow(): Promise<DeviceInfo[]> {
    const found = await Dadb.list({ ...dadbOptions, ...usbBackendOption });
    const serials = new Set(found.map((d) => d.serial));
    for (const [serial, entry] of entries) {
      if (!serials.has(serial)) {
        entries.delete(serial);
        void entry.session?.close();
        void entry.dadb.close();
      }
    }
    for (const dadb of found) {
      if (entries.has(dadb.serial)) void dadb.close(); // 이미 추적 중이면 새로 만든 핸들은 버린다
      else entryFor(dadb.serial, dadb);
    }

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

  /** 온보딩을 한 기기당 하나만 돌린다. 진행 중이면 그 결과를 기다리고, 방금 실패했으면 백오프 동안 다시 돌리지 않는다. */
  function ensureHelper(entry: TrackedDevice): Promise<void> {
    if (!entry.onboarding && entry.helperFailedAt !== undefined && Date.now() - entry.helperFailedAt < helperRetryBackoffMs) {
      return Promise.resolve();
    }
    entry.onboarding ??= onboardHelper(entry)
      .then(() => { entry.helperFailedAt = entry.helper?.state === 'ready' ? undefined : Date.now(); })
      .finally(() => { entry.onboarding = undefined; });
    return entry.onboarding;
  }

  /** ready 로 기록된 헬퍼가 지금도 응답하는지 가볍게 확인하고, 아니면 온보딩으로 상태를 갱신한다(device.info 가 stale 하지 않도록). */
  async function recheckHelper(entry: TrackedDevice): Promise<void> {
    if (entry.helper?.state !== 'ready' || !entry.session) return;
    // 방금 응답한 헬퍼는 살아 있다: 다른 요청(Studio 스냅샷 등)으로 바쁜 헬퍼를 ping 으로 더 두드리지 않는다
    if (Date.now() - entry.session.lastOkAt < helperFreshMs) return;
    const session = entry.session;
    try {
      await session.ping();
    } catch {
      // 한 번의 실패(바쁨·일시 지연)로 죽었다고 보지 않는다: 잠깐 뒤 한 번 더 — 그래도 안 되면 온보딩으로 상태를 갱신
      await new Promise((r) => setTimeout(r, HELPER_RECHECK_RETRY_MS));
      try { await session.ping(); return; } catch { /* 아래에서 온보딩 */ }
      entry.helper = { state: 'pending' };
      await ensureHelper(entry);
    }
  }

  /**
   * 헬퍼 온보딩: 설치 → 접근성 서비스 활성화(--user 0) → 포워드 → 토큰 → /ping. 결과는 entry.helper 에 남는다.
   * 어느 단계가 실패해도 던지지 않고 상태(not-installed/disabled/unreachable)로 기록한다. ensureHelper 를 통해서만 부른다.
   */
  async function onboardHelper(entry: TrackedDevice): Promise<void> {
    const sh = async (command: string) => (await entry.dadb.shell(command)).output;
    const fail = (state: HelperInfo['state'], detail: string) => { entry.helper = { state, detail }; };
    const step = (text: string) => options.onHelperStep?.(entry.dadb.serial, text);
    const retries = options.helperActivate?.retries ?? ACTIVATE_RETRIES;
    const intervalMs = options.helperActivate?.intervalMs ?? ACTIVATE_RETRY_MS;
    try {
      if (!(await sh(`pm path ${shellQuote(HELPER_PACKAGE)}`)).includes('package:')) {
        const apk = options.helperApkPath ?? devHelperApk();
        if (!apk || !existsSync(apk)) return fail('not-installed', `헬퍼 APK 가 없음: ${apk ?? '(경로 없음)'} (android-helper 를 빌드하거나 helperApkPath 를 지정)`);
        step(`헬퍼 설치 중: ${apk}`);
        const installed = await entry.dadb.install(apk, '-r');
        if (!installed.success) return fail('not-installed', `헬퍼 설치 실패: ${installed.reason}`);
        step('헬퍼 설치됨');
      } else {
        step('헬퍼 이미 설치됨');
      }

      // Secure Folder 가 있는 Samsung 은 --user 0 이 없으면 다른 사용자에 쓰여 서비스가 켜지지 않는다.
      let activated = false;
      for (let attempt = 0; attempt < retries && !activated; attempt++) {
        if (attempt > 0) { step(`접근성 활성화 재시도 ${attempt}/${retries - 1}`); await new Promise((r) => setTimeout(r, intervalMs)); }
        const current = (await sh('settings get --user 0 secure enabled_accessibility_services')).trim();
        if (!current.includes(HELPER_SERVICE)) {
          const list = current && current !== 'null' ? `${current}:${HELPER_SERVICE}` : HELPER_SERVICE;
          await sh(`settings put --user 0 secure enabled_accessibility_services ${shellQuote(list)}`);
        }
        await sh('settings put --user 0 secure accessibility_enabled 1');
        activated = (await sh('settings get --user 0 secure enabled_accessibility_services')).includes(HELPER_SERVICE);
      }
      if (!activated) {
        return fail('disabled', '접근성 서비스 활성화 설정이 적용되지 않음(settings put --user 0 거부). 기기의 접근성 설정에서 Sinclair Helper 를 켜세요');
      }
      step('접근성 서비스 활성화됨');

      entry.session ??= await HelperSession.open(entry.dadb);
      await entry.session.sendToken();

      const deadline = Date.now() + HELPER_START_TIMEOUT_MS;
      let last: unknown;
      let tokenResent = false;
      for (;;) {
        try {
          const ping = await entry.session.ping();
          entry.helper = { state: 'ready', version: ping.version };
          step(`헬퍼 준비됨 v${ping.version}`);
          return;
        } catch (e) {
          last = e;
          // 서버는 떠 있다(HTTP 응답). 401 이면 토큰이 사라진 것일 수 있어 한 번 다시 보내고, 그래도 401 이면 기다릴 이유가 없다.
          // 그 밖의 HTTP 오류는 기동 중 일시 오류일 수 있어 기한까지 다시 묻는다.
          if (e instanceof HelperHttpError && e.status === 401) {
            if (tokenResent) break;
            tokenResent = true;
            await entry.session.sendToken();
          }
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, HELPER_POLL_MS));
        }
      }
      if (last instanceof HelperHttpError) return fail('unreachable', `헬퍼가 응답했지만 요청을 거부함(HTTP ${last.status}): ${last.body}`);
      return fail('disabled', `접근성 서비스가 켜졌지만 헬퍼 서버가 뜨지 않음: ${last instanceof Error ? last.message : String(last)}`);
    } catch (e) {
      return fail('unreachable', `헬퍼 온보딩 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 추적 중인 기기를 돌려준다. 모르는 id 면 한 번 열거한다(디스패처의 find 가 먼저 listDevices 를 부르지만 직접 호출도 지원). */
  async function tracked(deviceId: string): Promise<TrackedDevice> {
    let entry = entries.get(deviceId);
    if (!entry) {
      await refresh();
      entry = entries.get(deviceId);
    }
    if (!entry) throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${deviceId}`);
    return entry;
  }

  /**
   * 헬퍼가 준비된 세션으로 요청을 보낸다. 실패하면 온보딩을 다시 돌려 상태를 갱신하고 한 번 더 시도한다(서비스 꺼짐·토큰 소실 복구).
   * fallback 을 주면 헬퍼 경로가 안 될 때 던지는 대신 그것을 쓴다(screencap 등 대체 경로가 있는 호출용).
   */
  async function withHelper<T>(deviceId: string, call: (session: HelperSession) => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    const entry = await tracked(deviceId);
    await entry.probe; // 연결 판정(과 그에 딸린 온보딩)이 진행 중이면 끝날 때까지
    if (entry.helper?.state !== 'ready' && !fallback) await ensureHelper(entry);
    let firstError: unknown;
    if (entry.helper?.state === 'ready' && entry.session) {
      try {
        return await call(entry.session);
      } catch (e) {
        firstError = e;
        if (fallback) return fallback();
        await ensureHelper(entry);
        if (entry.helper?.state === 'ready' && entry.session) return call(entry.session);
      }
    }
    if (fallback) return fallback();
    const cause = firstError instanceof Error ? ` (첫 시도: ${firstError.message})` : '';
    throw new RpcError(RPC_ERRORS.helperUnavailable, `헬퍼 사용 불가(${entry.helper?.state}): ${entry.helper?.detail ?? ''}${cause}`);
  }

  const dumpUi = (deviceId: string): Promise<SemanticNode> => withHelper(deviceId, (s) => s.dump());

  /** 같은 순간의 스크린샷+트리. 헬퍼가 스크린샷을 못 주면(Android 11 미만, 간격 제한) screencap 으로 따로 찍고 atomic:false. */
  async function snapshot(deviceId: string): Promise<SnapshotResult> {
    const capturedAt = new Date().toISOString();
    const r = await withHelper(deviceId, (s) => s.snapshot());
    if (r.screenshot && r.atomic) return { screenshot: r.screenshot, root: r.root, atomic: true, capturedAt };
    const png = await runBinary(deviceId, 'screencap -p');
    return {
      screenshot: { format: 'png', base64: Buffer.from(png).toString('base64') },
      root: r.root,
      atomic: false,
      capturedAt,
      detail: r.detail ?? '헬퍼가 스크린샷 없이 응답함',
    };
  }

  /** 헬퍼가 준비돼 있으면 헬퍼 경로(원자 캡처의 스크린샷)를 쓰고, 아니면 screencap. 헬퍼 상태 갱신은 다음 info/dump 에서. */
  function screenshot(deviceId: string): Promise<Uint8Array> {
    const screencap = () => runBinary(deviceId, 'screencap -p');
    return withHelper(deviceId, async (s) => {
      const r = await s.snapshot();
      return r.screenshot ? Buffer.from(r.screenshot.base64, 'base64') : screencap();
    }, screencap);
  }

  const notImplemented = (name: string) => async (..._args: unknown[]): Promise<never> => {
    throw new Error(`AndroidBackend.${name} 은 아직 구현되지 않았습니다`);
  };

  function dadbFor(deviceId: string): Dadb {
    const entry = entries.get(deviceId);
    if (!entry) throw new RpcError(RPC_ERRORS.deviceNotFound, `기기를 찾을 수 없음: ${deviceId}`);
    return entry.dadb;
  }

  /** 오류 문구에 실을 명령. input text 는 입력한 글자(비밀번호일 수 있다)를 싣지 않는다 */
  const shownCommand = (command: string): string => (command.startsWith('input text ') ? 'input text <입력값>' : command);

  /** 셸 명령을 실행하고 종료 코드가 0이 아니면 출력을 담아 던진다. */
  async function run(deviceId: string, command: string): Promise<string> {
    const r = await dadbFor(deviceId).shell(command);
    if (r.exitCode !== 0) throw new Error(`셸 명령 실패(exit ${r.exitCode}): ${shownCommand(command)}\n${r.allOutput.trim()}`);
    return r.allOutput;
  }

  const runVoid = (deviceId: string, command: string) => run(deviceId, command).then(() => undefined);
  const input = (deviceId: string, args: string) => runVoid(deviceId, `input ${args}`);

  function reportInput(event: InputRouteEvent): void {
    if (ADB_TRACE) adbTrace(`input ${event.deviceId} ${event.action} via ${event.route}${event.fallback ? ` (${event.fallback.kind}: ${event.fallback.detail})` : ''}`);
    options.onInput?.(event);
  }

  /**
   * 입력 경로 선택(ADR 0003): 헬퍼가 ready 면 접근성 제스처/setText, 아니면 `adb shell input`. 헬퍼가 거부하면(제스처 취소,
   * 포커스 없음 등) 같은 호출을 shell 로 한 번 재시도한다. shell 경로가 불가한 입력(비ASCII 텍스트)은 shellFallback 이 던진다.
   * 전제: 같은 기기의 입력은 겹치지 않는다. JSON-RPC 를 거치면 디스패처가 기기별로 직렬화한다. 백엔드를 직접 쓰는 호출자는
   * 스스로 직렬화해야 한다(진행 중인 제스처가 있으면 dispatchGesture 가 거부해 shell 로 떨어진다).
   * 지연: 헬퍼 호출이 timeout(5초) 으로 실패하면 shell 재시도까지 그만큼 더 걸린다. 그 사실은 fallback 으로만 드러난다.
   */
  async function routedInput(deviceId: string, action: InputRouteEvent['action'], helperBody: HelperAction, shellFallback: () => Promise<void>): Promise<void> {
    const entry = await tracked(deviceId);
    await entry.probe;
    let fallback: NonNullable<InputRouteEvent['fallback']>;
    if (options.preferShellInput) {
      fallback = { kind: 'preferred', detail: 'preferShellInput 옵션' };
    } else if (entry.helper?.state === 'ready' && entry.session) {
      try {
        await entry.session.action(helperBody);
        reportInput({ deviceId, action, route: 'helper' });
        return;
      } catch (e) {
        fallback = e instanceof HelperHttpError && e.status === 409
          ? { kind: 'refused', detail: e.detail }
          : { kind: 'unavailable', detail: `헬퍼 호출 실패: ${e instanceof Error ? e.message : String(e)}` };
      }
    } else {
      fallback = { kind: 'unavailable', detail: `헬퍼 ${entry.helper?.state ?? 'none'}${entry.helper?.detail ? `: ${entry.helper.detail}` : ''}` };
    }
    try {
      await shellFallback();
    } catch (e) {
      // 두 경로 모두 실패: 헬퍼를 왜 못 썼는지가 없으면 "헬퍼가 필요합니다" 류 메시지가 오해를 부른다. 두 이유를 함께 던진다.
      const message = e instanceof Error ? e.message : String(e);
      reportInput({ deviceId, action, route: 'shell', fallback, failed: message });
      const combined = `${message} (헬퍼 경로 불가: ${fallback.detail})`;
      throw e instanceof RpcError ? new RpcError(e.code, combined, e.data) : new Error(combined);
    }
    reportInput({ deviceId, action, route: 'shell', fallback });
  }

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
          if (packet.exitCode !== 0) throw new Error(`셸 명령 실패(exit ${packet.exitCode}): ${shownCommand(command)}\n${Buffer.concat(err).toString('utf-8').trim()}`);
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
      const entry = await tracked(deviceId);
      await recheckHelper(entry);
      return toInfo(deviceId, entry);
    },
    screenshot,
    dumpUi,
    snapshot,
    tap: (id, p) => routedInput(id, 'tap', { action: 'tap', x: p.x, y: p.y }, () => input(id, `tap ${p.x} ${p.y}`)),
    longPress: (id, p, durationMs) => routedInput(id, 'longPress', { action: 'long_press', x: p.x, y: p.y, durationMs },
      () => input(id, `swipe ${p.x} ${p.y} ${p.x} ${p.y} ${durationMs}`)),
    swipe: (id, from, to, durationMs) => routedInput(id, 'swipe', { action: 'swipe', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs },
      () => input(id, `swipe ${from.x} ${from.y} ${to.x} ${to.y} ${durationMs}`)),
    text: (id, text) => routedInput(id, 'text', { action: 'type', text }, async () => {
      // `input text` 는 ASCII 만 받는다(비ASCII 는 기기에서 무시되거나 깨진다). 한글 등은 접근성 헬퍼 경로(setText)가 맡는다.
      // 알려진 한계: `input text` 는 `%s` 를 공백으로 해석하므로 리터럴 "%s" 는 전달할 수 없다(이스케이프 수단 없음).
      if (!/^[\x20-\x7e]*$/.test(text)) {
        throw new RpcError(RPC_ERRORS.invalidParams, 'input text 는 ASCII 만 지원합니다. 비ASCII 텍스트는 접근성 헬퍼가 필요합니다');
      }
      await input(id, `text ${shellQuote(text.replace(/ /g, '%s'))}`);
    }),
    keys: async (id, keys) => {
      // 키 이름은 인용 없이 보간되므로 화이트리스트로만 허용한다(셸 명령 삽입 방지).
      const bad = keys.find((k) => !KEY_NAME.test(k));
      if (bad !== undefined) throw new RpcError(RPC_ERRORS.invalidParams, `허용되지 않는 키 이름: ${bad} (KEYCODE_* 또는 숫자 키코드만)`);
      return input(id, `keyevent ${keys.join(' ')}`);
    },
    button: (id, name) => input(id, `keyevent ${BUTTON_KEYCODES[name]}`),
    // 화면 키보드: InputMethodManagerService 의 mInputShown. 그 줄이 없는 기기·버전이면 모른다(undefined) — 에이전트는 그러면 키보드를 내리지 않는다
    keyboardShown: async (id) => {
      const out = await run(id, 'dumpsys input_method');
      const m = /\bmInputShown=(true|false)\b/.exec(out);
      return m ? m[1] === 'true' : undefined;
    },
    // 앞 화면 앱: resumed 액티비티(안드로이드 10+ topResumedActivity, 그 전 mResumedActivity), 없으면 포커스 창. 출력이 커서 grep 으로 줄만
    foregroundApp: async (id) => {
      const sh = async (cmd: string) => (await dadbFor(id).shell(cmd)).output;
      return parseForegroundApp(await sh('dumpsys activity activities | grep -m1 -E "topResumedActivity=|mResumedActivity:"')) ?? parseForegroundApp(await sh('dumpsys window | grep -m1 mCurrentFocus='));
    },
    screenState: async (id) => {
      const sh = async (cmd: string) => (await dadbFor(id).shell(cmd)).output;
      // dumpsys window 전체는 수백 KB 라 grep 으로 줄만 뽑는다
      return parseScreenState(await sh('dumpsys power | grep -m1 mWakefulness='), await sh('dumpsys window | grep -m1 -E "mDreamingLockscreen=|isStatusBarKeyguard="'));
    },
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
      await Promise.allSettled(all.map((e) => e.session?.close()));
      await Promise.allSettled(all.map((e) => e.dadb.close()));
    },
  };
}
