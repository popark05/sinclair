// 엔진 팩토리: fake(로그인 시나리오) 또는 mobile(디바이스 레이어 Android 백엔드 위 engine-mobile). 엔진 수명은 run 하나.
import type { Engine } from '@sinclair/protocol';
// testing/index 는 vitest 계약 스위트를 끌어오므로(vitest 밖에서 import 불가) 파일 단위 export 를 쓴다
import { FakeEngine } from '@sinclair/protocol/testing/fake-engine';
import { HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing/login-scenario';
import { createAndroidBackend, createDeviceServer } from '@sinclair/device-layer';
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

/** 테스트용: APK 해석 단계의 번들·리포 빌드 위치를 바꿔 끼운다 */
export interface EngineOverrides { bundledDir?: string; repoBuild?: string }

export async function createEngine(args: RunArgs, log: (line: string) => void, overrides: EngineOverrides = {}): Promise<EngineHandle> {
  if (args.engine === 'fake') {
    const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    return { engine, dispose: () => engine.dispose(), deviceId: 'fake', deviceLabel: 'fake' };
  }
  // USB 를 건드리기 전에 APK 부터: 없으면 기기 상태와 무관하게 "헬퍼 APK 없음" 으로 빨리 실패한다
  const helperApk = await resolveHelperApk({ ...(args.helperApk ? { flag: args.helperApk } : {}), env: process.env, cacheDir: args.helperCache, log, ...overrides });
  const backend = createAndroidBackend({
    dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS, helperApkPath: helperApk.path,
    onHelperStep: (serial, text) => log(`헬퍼 온보딩(…${serial.slice(-4)}): ${text}`),
  });
  try {
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
    // 화면이 꺼져 있거나 비보안 잠금화면이면 트리가 비어 모든 locator 가 실패한다. 깨우고 잠금화면을 넘기고 홈으로 간다(창 이벤트도 만든다)
    await backend.keys(deviceId, ['KEYCODE_WAKEUP', 'KEYCODE_MENU', 'KEYCODE_HOME']).catch(() => undefined);
    if (info.helper?.state === 'ready') {
      for (let i = 0; i < TREE_READY_POLLS; i++) {
        const root = await backend.dumpUi(deviceId).catch(() => undefined);
        if (root && (root.children?.length ?? 0) > 0) break;
        if (i === 0) log('헬퍼 트리가 아직 비어 있음, 창 이벤트를 기다림');
        await new Promise((r) => setTimeout(r, TREE_READY_MS));
      }
    }
    const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([backend])), { deviceId, ...(args.app ? { appId: args.app } : {}) });
    return {
      engine, deviceId, deviceLabel: label,
      async dispose() {
        await engine.session?.restart().catch(() => undefined);
        if (args.app) await backend.terminateApp(deviceId, args.app).catch(() => undefined);
        await backend.button(deviceId, 'home').catch(() => undefined);
        await backend.close();
      },
    };
  } catch (err) {
    await backend.close().catch(() => undefined);
    throw err;
  }
}
