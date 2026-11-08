// 엔진 팩토리: fake(로그인 시나리오) 또는 mobile(디바이스 레이어 Android 백엔드 위 engine-mobile). 엔진 수명은 run 하나,
// 백엔드 수명은 그것을 연 쪽이 정한다(`run` 은 run 하나, 데몬은 데몬 수명 동안 openAndroidNode 로 하나를 연다).
import type { Engine, NodeDevice } from '@sinclair/protocol';
// testing/index 는 vitest 계약 스위트를 끌어오므로(vitest 밖에서 import 불가) 파일 단위 export 를 쓴다
import { FakeEngine } from '@sinclair/protocol/testing/fake-engine';
import { HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing/login-scenario';
import { createAndroidBackend, createDeviceServer, type ScreenState } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '@sinclair/engine-mobile';
import type { RunArgs } from './args.ts';
import { resolveHelperApk } from './helper-apk.ts';
// 기기 준비(깨우기)·정리(앱 종료, 홈) 시퀀스는 packages/runner/test/runner.device.test.ts 와 같다. device-layer 에 prepare/cleanup 헬퍼로 올리는 것은 05(헬퍼 APK) 에서.

export interface EngineHandle {
  engine: Engine;
  dispose(): Promise<void>;
  /** run.started.deviceId 에 실을 기기 식별자(시리얼). 증거 파일에 쓸 때는 마스킹한다 */
  deviceId?: string;
  /** 로그용 라벨(모델·마스킹 시리얼·OS) */
  deviceLabel?: string;
}

/** 처음 보는 호스트 키면 "USB 디버깅 허용" 을 사람이 눌러야 하므로 승인 대기를 60초 준다 */
const APPROVAL_WAIT_MS = 60_000;
/** 헬퍼 온보딩(설치·접근성 활성화) 대기: 250ms × 40 = 10초 */
const PENDING_POLL_MS = 250;
const PENDING_POLLS = 40;
/** 기기 목록 재시도: 다른 프로세스가 USB 인터페이스를 막 놓았거나 기기가 방금 꽂힌 직후에는 목록이 잠깐 비어 있다. 500ms × 6 = 3초 */
const LIST_RETRY_MS = 500;
const LIST_RETRIES = 6;
/** 막 켜진 접근성 서비스는 창 이벤트를 하나 받기 전까지 빈 트리를 돌려준다(실기기에서 재설치 직후 확인). HOME 으로 창을 바꾸고 트리가 찰 때까지 500ms × 10 = 5초 */
const TREE_READY_MS = 500;
const TREE_READY_POLLS = 10;
/** 예열: 대상 앱 첫 실행의 트리가 노드 몇 개 이상이 될 때까지 500ms × 20 = 10초(앱 콜드 스타트 포함) */
const WARMUP_POLL_MS = 500;
const WARMUP_POLLS = 20;
const WARMUP_MIN_NODES = 5;
const countNodes = (n: { children?: unknown[] }): number => 1 + ((n.children ?? []) as Array<{ children?: unknown[] }>).reduce((a, c) => a + countNodes(c), 0);

/** 테스트용: APK 해석 단계의 번들·리포 빌드 위치를 바꿔 끼운다 */
export interface EngineOverrides { bundledDir?: string; repoBuild?: string }

/** fake 엔진 노드가 보고하는 가짜 기기(Fleet 테스트·verify 스킬용). 언제나 쓸 수 있는 상태 */
export const FAKE_DEVICE: NodeDevice = { id: 'fake', platform: 'android', model: 'FakeEngine', osVersion: '0', connection: 'device', helper: 'ready', locked: false };

/** 디바이스 백엔드 하나를 소유하는 Android 노드. 데몬은 하나를 열어 두고 인벤토리와 run 들이 같이 쓴다(직접 USB 는 한 프로세스만 잡을 수 있다).
 *  `run` 명령은 run 하나 동안만 연다(createEngine) */
export interface AndroidNode {
  /** 꽂힌 기기와 연결·헬퍼·화면 잠금 상태(Fleet 보고용). 잠금 확인이 실패하면 locked 를 비운다(모름) */
  inventory(): Promise<NodeDevice[]>;
  /** 이 노드의 백엔드 위에 run 하나용 엔진을 만든다. dispose 는 앱을 정리할 뿐 백엔드를 닫지 않는다 */
  engineFor(args: RunArgs, log: (line: string) => void): Promise<EngineHandle>;
  close(): Promise<void>;
}

export async function openAndroidNode(args: Pick<RunArgs, 'helperApk' | 'helperCache'>, log: (line: string) => void, overrides: EngineOverrides = {}): Promise<AndroidNode> {
  // USB 를 건드리기 전에 APK 부터: 없으면 기기 상태와 무관하게 "헬퍼 APK 없음" 으로 빨리 실패한다
  const helperApk = await resolveHelperApk({ ...(args.helperApk ? { flag: args.helperApk } : {}), env: process.env, cacheDir: args.helperCache, log, ...overrides });
  // listDevices 가 첫 판정(온보딩 포함)을 기다리므로 "방금 설치·활성화했는지" 는 info 상태가 아니라 온보딩 단계 콜백으로 안다
  // 방금 설치·활성화한 기기들. 그 기기의 첫 run 이 예열까지 마쳐야 지운다(앞선 run 이 예열 전에 실패하면 다음 run 이 이어받는다)
  const needsWarmup = new Set<string>();
  // run 이 쓰는 중인 기기와 그 기기의 마지막 잠금 상태: 인벤토리가 run 도중 그 기기에 dumpsys 를 보내지 않게 한다(쓰는 중이면 잠금 해제 상태다)
  const inUse = new Set<string>();
  const lastLocked = new Map<string, boolean>();
  const backend = createAndroidBackend({
    dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS, helperApkPath: helperApk.path,
    onHelperStep: (serial, text) => { if (/(?<!이미 )설치됨|활성화됨/.test(text)) needsWarmup.add(serial); log(`헬퍼 온보딩(…${serial.slice(-4)}): ${text}`); },
  });
  return {
    async inventory() {
      const devices = await backend.listDevices();
      return Promise.all(devices.map(async (d): Promise<NodeDevice> => {
        const screen = d.state !== 'device' ? undefined
          : inUse.has(d.id) ? (lastLocked.has(d.id) ? { locked: lastLocked.get(d.id)! } : undefined)
          : await backend.screenState?.(d.id).catch(() => undefined);
        if (screen?.locked !== undefined) lastLocked.set(d.id, screen.locked);
        return { id: d.id, platform: d.platform, model: d.model, osVersion: d.osVersion, connection: d.state, ...(d.helper ? { helper: d.helper.state } : {}), ...(screen?.locked !== undefined ? { locked: screen.locked } : {}) };
      }));
    },
    async engineFor(args, log) {
      let devices = await backend.listDevices();
      for (let i = 0; i < LIST_RETRIES && !devices.some((d) => (args.device ? d.id === args.device : true)); i++) {
        await new Promise((r) => setTimeout(r, LIST_RETRY_MS));
        devices = await backend.listDevices();
      }
      const deviceId = args.device ?? devices[0]?.id;
      if (!deviceId) throw new Error('꽂힌 Android 기기가 없음');
      if (!devices.some((d) => d.id === deviceId)) throw new Error(`기기 ${deviceId} 가 목록에 없음(${devices.map((d) => d.id).join(', ') || '없음'})`);
      let info = await backend.info(deviceId);
      for (let i = 0; i < PENDING_POLLS && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, PENDING_POLL_MS)); info = await backend.info(deviceId); }
      const label = `${info.model} (…${deviceId.slice(-4)}) Android ${info.osVersion}`;
      log(`기기 ${label}, 헬퍼 ${info.helper?.state ?? '알 수 없음'}`);
      // 화면이 꺼져 있거나 잠금화면이면 트리가 비어 모든 locator 가 실패한다. 깨우고(WAKEUP) 비보안 잠금을 넘기고(MENU, 위로 스와이프) 홈으로 간다.
      // 그래도 트리가 비면 보안 잠금(PIN·패턴)이라 프로그램으로 풀 수 없다 — 테스트를 돌려 엉뚱하게 실패시키지 않고 여기서 사유를 밝히고 멈춘다
      await backend.keys(deviceId, ['KEYCODE_WAKEUP', 'KEYCODE_MENU']).catch(() => undefined);
      // 잠금화면도 노드를 가지므로 트리가 비었는지로는 못 가른다. dumpsys 로 직접 본다(비보안 잠금은 위로 스와이프로 풀어 본다)
      let screen: ScreenState = (await backend.screenState?.(deviceId).catch(() => ({}))) ?? {};
      if (screen.locked) {
        await backend.swipe(deviceId, { x: 540, y: 1900 }, { x: 540, y: 700 }, 300).catch(() => undefined); // 화면 아래→위(1080×2400 기준, 다른 해상도도 비율상 화면 안)
        await new Promise((r) => setTimeout(r, 500));
        screen = (await backend.screenState?.(deviceId).catch(() => ({}))) ?? {};
        if (screen.locked) throw new Error('기기 화면이 잠겨 있음(보안 잠금은 프로그램으로 풀 수 없음). 기기 잠금을 해제하고 화면 꺼짐 시간을 늘린 뒤 다시 실행');
      }
      log(`화면: ${screen.awake === undefined ? '상태 모름' : screen.awake ? '켜짐' : '꺼짐'}, 잠금 ${screen.locked === undefined ? '모름' : screen.locked ? '있음' : '없음'}`);
      if (info.helper?.state === 'ready') {
        const treeFilled = async (): Promise<boolean> => {
          for (let i = 0; i < TREE_READY_POLLS; i++) {
            const root = await backend.dumpUi(deviceId).catch(() => undefined);
            if (root && (root.children?.length ?? 0) > 0) return true;
            await new Promise((r) => setTimeout(r, TREE_READY_MS));
          }
          return false;
        };
        if (!(await treeFilled())) log('헬퍼 트리가 비어 있음(창 이벤트 전). 계속 진행');
        await backend.keys(deviceId, ['KEYCODE_HOME']).catch(() => undefined); // 홈에서 시작(창 이벤트도 만든다)
      }
      const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([backend])), { deviceId, ...(args.app ? { appId: args.app } : {}) });
      // 여기까지 왔으면 잠금이 풀려 있다. 이제부터 dispose 까지 인벤토리는 이 기기에 dumpsys 를 보내지 않는다
      inUse.add(deviceId);
      lastLocked.set(deviceId, false);
      if (needsWarmup.has(deviceId) && info.helper?.state === 'ready' && args.app) {
        // 막 설치·활성화된 접근성 서비스는 첫 앱 실행의 창 내용을 한동안(5초 넘게) 비어 있는 트리로 돌려준다(실기기 재설치 직후 반복 확인).
        // 테스트가 그 창을 만나지 않도록 대상 앱을 한 번 열어 트리가 찰 때까지 기다렸다가 닫는다
        log('헬퍼를 방금 켰으므로 대상 앱을 한 번 열어 트리를 예열함');
        await engine.session!.open().catch(() => undefined);
        for (let i = 0; i < WARMUP_POLLS; i++) {
          const root = await backend.dumpUi(deviceId).catch(() => undefined);
          if (root && countNodes(root) >= WARMUP_MIN_NODES) break;
          await new Promise((r) => setTimeout(r, WARMUP_POLL_MS));
        }
        await backend.terminateApp(deviceId, args.app).catch(() => undefined);
        await backend.button(deviceId, 'home').catch(() => undefined);
        needsWarmup.delete(deviceId);
      }
      return {
        engine, deviceId, deviceLabel: label,
        async dispose() {
          await engine.session?.restart().catch(() => undefined);
          if (args.app) await backend.terminateApp(deviceId, args.app).catch(() => undefined);
          await backend.button(deviceId, 'home').catch(() => undefined);
          inUse.delete(deviceId);
          // 백엔드는 닫지 않는다: 노드(데몬)가 소유하고 다음 run·인벤토리가 같이 쓴다
        },
      };
    },
    close: () => backend.close(),
  };
}

export async function createEngine(args: RunArgs, log: (line: string) => void, overrides: EngineOverrides = {}): Promise<EngineHandle> {
  if (args.engine === 'fake') {
    const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    return { engine, dispose: () => engine.dispose(), deviceId: 'fake', deviceLabel: 'fake' };
  }
  const node = await openAndroidNode(args, log, overrides);
  try {
    const handle = await node.engineFor(args, log);
    return { ...handle, dispose: async () => { await handle.dispose(); await node.close(); } };
  } catch (err) {
    await node.close().catch(() => undefined);
    throw err;
  }
}
