// 엔진 팩토리: fake(로그인 시나리오) 또는 mobile(디바이스 레이어 Android 백엔드 위 engine-mobile). 엔진 수명은 run 하나.
import type { Engine } from '@sinclair/protocol';
// testing/index 는 vitest 계약 스위트를 끌어오므로(vitest 밖에서 import 불가) 파일 단위 export 를 쓴다
import { FakeEngine } from '@sinclair/protocol/testing/fake-engine';
import { HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing/login-scenario';
import { createAndroidBackend, createDeviceServer } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '@sinclair/engine-mobile';
import type { RunArgs } from './args.ts';
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

export async function createEngine(args: RunArgs, log: (line: string) => void): Promise<EngineHandle> {
  if (args.engine === 'fake') {
    const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    return { engine, dispose: () => engine.dispose(), deviceId: 'fake', deviceLabel: 'fake' };
  }
  const backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS });
  try {
    const devices = await backend.listDevices();
    const deviceId = args.device ?? devices[0]?.id;
    if (!deviceId) throw new Error('꽂힌 Android 기기가 없음');
    if (!devices.some((d) => d.id === deviceId)) throw new Error(`기기 ${deviceId} 가 목록에 없음(${devices.map((d) => d.id).join(', ') || '없음'})`);
    let info = await backend.info(deviceId);
    for (let i = 0; i < PENDING_POLLS && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, PENDING_POLL_MS)); info = await backend.info(deviceId); }
    const label = `${info.model} (…${deviceId.slice(-4)}) Android ${info.osVersion}`;
    log(`기기 ${label}, 헬퍼 ${info.helper?.state ?? '알 수 없음'}`);
    // 화면이 꺼져 있거나 비보안 잠금화면이면 트리가 비어 모든 locator 가 실패한다. 깨우고 잠금화면을 넘긴다
    await backend.keys(deviceId, ['KEYCODE_WAKEUP', 'KEYCODE_MENU']).catch(() => undefined);
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
