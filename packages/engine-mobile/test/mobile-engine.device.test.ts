// @vitest-environment node
/**
 * 실기기(opt-in): engine-mobile 이 실제 Android 기기(Samsung 전화 앱)에서 엔진 계약 스위트를 통과한다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run packages/engine-mobile/test/mobile-engine.device.test.ts
 * 전제: 기기 잠금 해제. 전화 앱(com.samsung.android.dialer) 키패드 화면: digits 입력 필드, "검색" 버튼 → 검색 화면의 search_src_text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAndroidBackend, createDeviceServer, type AndroidBackend } from '@sinclair/device-layer';
import { engineContractSuite, type ContractScenario } from '@sinclair/protocol/testing';
import { createMobileEngine, rpcOverDispatcher } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
/** 처음 보는 호스트 키면 "USB 디버깅 허용" 을 사람이 눌러야 하므로 승인 대기를 60초 준다. */
const APPROVAL_WAIT_MS = 60_000;
const DIALER = 'com.samsung.android.dialer';

const DIALER_SCENARIO: ContractScenario = {
  navButton: { role: 'button', name: '검색', exact: true },
  afterNav: { testId: 'search_src_text' },
  textbox: { testId: 'digits', typeText: '12' }, // 전화 번호 필드는 숫자만 받는다
  nonEditable: { role: 'button', name: '통화', exact: true },
};

let backend: AndroidBackend | undefined;
let deviceId = '';

describe.skipIf(!target)('실기기 engine-mobile', () => {
  beforeAll(async () => {
    backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS });
    const [device] = await backend.listDevices();
    deviceId = target === '1' ? device!.id : target!;
    let info = await backend.info(deviceId);
    for (let i = 0; i < 40 && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, 250)); info = await backend.info(deviceId); }
    expect(info.helper?.state, JSON.stringify(info.helper)).toBe('ready');
    await backend.keys(deviceId, ['KEYCODE_WAKEUP']);
  }, APPROVAL_WAIT_MS + 10_000);

  afterAll(async () => {
    if (backend) {
      await backend.terminateApp(deviceId, DIALER).catch(() => undefined);
      await backend.button(deviceId, 'home').catch(() => undefined);
      await backend.close();
    }
    const dir = path.resolve(import.meta.dirname, '../../../.scratch/runner-locator/evidence');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '02-engine-mobile-device-latest.json'), JSON.stringify({ at: new Date().toISOString(), deviceId, app: DIALER, scenario: DIALER_SCENARIO, note: '계약 스위트 전체를 실기기에서 실행. 결과는 vitest 출력 참고' }, null, 2) + '\n');
  });

  engineContractSuite('engine-mobile(실기기, Samsung 전화 앱)', {
    makeEngine: () => createMobileEngine(rpcOverDispatcher(createDeviceServer([backend!])), { deviceId, appId: DIALER }),
    scenario: DIALER_SCENARIO,
  });
});
