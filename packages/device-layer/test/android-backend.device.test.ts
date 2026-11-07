// @vitest-environment node
/**
 * 실기기 검증(opt-in): USB 로 꽂은 Android 기기가 AndroidBackend 의 devices.list 에 나온다.
 *
 *  1. 기기에서 USB 디버깅 켜기, 케이블 연결
 *  2. adb kill-server  (adb server 가 USB 인터페이스를 점유한다)
 *  3. SINCLAIR_TEST_USB=1 npx vitest run packages/device-layer/test/android-backend.device.test.ts
 *     (1 = 아무 기기, 또는 시리얼. 처음 보는 키면 기기에서 60초 안에 "USB 디버깅 허용")
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAndroidBackend } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
/** 처음 보는 호스트 키면 기기의 "USB 디버깅 허용" 팝업을 사람이 눌러야 하므로 승인 대기를 60초 준다. */
const APPROVAL_WAIT_MS = 60_000;
const backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS });
afterAll(() => backend.close());

describe.skipIf(!target)('AndroidBackend 실기기', () => {
  it('꽂힌 기기가 device 상태로, 모델과 OS 버전과 함께 나온다', async () => {
    const devices = await backend.listDevices();
    const picked = target === '1' ? devices[0] : devices.find((d) => d.id === target);
    expect(picked, `USB ADB 기기를 찾지 못했습니다(SINCLAIR_TEST_USB=${target}). adb kill-server 와 케이블을 확인하세요. 목록: ${JSON.stringify(devices)}`).toBeDefined();
    expect(picked!.state, picked!.stateDetail).toBe('device');
    expect(picked!.model).not.toBe('');
    expect(picked!.osVersion).toMatch(/^\d/);
    expect((await backend.info(picked!.id)).id).toBe(picked!.id);
  }, APPROVAL_WAIT_MS + 10_000);
});

describe.skipIf(!target)('AndroidBackend 실기기 입력·스크린샷 (adb shell 경로)', () => {
  it('홈 → 스크린샷 A → 최근 앱 키 → 스크린샷 B 가 서로 다르고(화면 변화 증거), 두 장이 .e2e/ 에 남는다', async () => {
    const [device] = await backend.listDevices();
    const id = target === '1' ? device!.id : target!;
    const dir = path.resolve(import.meta.dirname, '../../../.e2e/device-proof');
    await fs.mkdir(dir, { recursive: true });
    await backend.button(id, 'home');
    await new Promise((r) => setTimeout(r, 500));
    const before = await backend.screenshot(id);
    await backend.keys(id, ['KEYCODE_APP_SWITCH']);
    await new Promise((r) => setTimeout(r, 800));
    const after = await backend.screenshot(id);
    await backend.button(id, 'back');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `${stamp}-before.png`), before);
    await fs.writeFile(path.join(dir, `${stamp}-after.png`), after);
    for (const png of [before, after]) {
      expect(Buffer.from(png.subarray(0, 8))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.length).toBeGreaterThan(10_000);
    }
    expect(Buffer.from(before).equals(Buffer.from(after)), `증거: ${dir}/${stamp}-{before,after}.png`).toBe(false);
    await backend.text(id, 'hello world');
    await backend.keys(id, ['KEYCODE_BACK']);
  }, APPROVAL_WAIT_MS + 10_000);
});

describe.skipIf(!target)('AndroidBackend 실기기 헬퍼 온보딩·dump.ui', () => {
  it('연결 직후 헬퍼가 ready 이고 device.dump.ui 가 실제 화면 트리(testId 포함)를 돌려준다', async () => {
    const [device] = await backend.listDevices();
    const id = target === '1' ? device!.id : target!;
    let info = await backend.info(id);
    for (let i = 0; i < 40 && info.helper === undefined; i++) {
      await new Promise((r) => setTimeout(r, 250));
      info = await backend.info(id);
    }
    expect(info.helper, JSON.stringify(info)).toMatchObject({ state: 'ready' });
    expect(info.helper?.version).toMatch(/^\d+\.\d+\.\d+$/);
    await backend.button(id, 'home');
    await new Promise((r) => setTimeout(r, 500));
    const tree = await backend.dumpUi(id);
    let nodes = 0, withId = 0;
    const walk = (n: typeof tree) => { nodes++; if (n.testId) withId++; for (const c of n.children ?? []) walk(c); };
    walk(tree);
    expect(tree.ref).toBe('@e0');
    expect(nodes).toBeGreaterThan(3);
    expect(withId).toBeGreaterThan(0);
  }, APPROVAL_WAIT_MS + 20_000);
});
