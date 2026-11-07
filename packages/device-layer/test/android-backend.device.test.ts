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
    await backend.keys(id, ['KEYCODE_WAKEUP', 'KEYCODE_MENU']); // 깨우고 잠금화면(비보안)을 넘긴다. 잠금화면의 스크린샷은 검게 나온다
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
    for (let i = 0; i < 40 && (info.helper === undefined || info.helper.state === 'pending'); i++) {
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
    const dir = path.resolve(import.meta.dirname, '../../../.e2e/device-proof');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-dump-ui.json`), JSON.stringify(tree, null, 2));
    expect(tree.ref).toBe('@e0');
    expect(nodes).toBeGreaterThan(3);
    expect(withId).toBeGreaterThan(0);
  }, APPROVAL_WAIT_MS + 20_000);
});

describe.skipIf(!target)('AndroidBackend 실기기 원자 스냅샷 (device.snapshot)', () => {
  it('최근 앱 전환 애니메이션 중 snapshot: atomic:true, PNG 크기가 루트 rect 와 일치하고 증거가 .e2e/ 에 남는다', async () => {
    const [device] = await backend.listDevices();
    const id = target === '1' ? device!.id : target!;
    let info = await backend.info(id);
    for (let i = 0; i < 40 && info.helper?.state === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      info = await backend.info(id);
    }
    expect(info.helper?.state, JSON.stringify(info.helper)).toBe('ready');
    await backend.keys(id, ['KEYCODE_WAKEUP', 'KEYCODE_MENU']); // 잠금화면(keyguard)에서는 takeScreenshot 이 검은 화면을 준다
    await backend.button(id, 'home');
    await new Promise((r) => setTimeout(r, 400));
    await backend.keys(id, ['KEYCODE_APP_SWITCH']); // 전환 애니메이션이 도는 동안 찍는다
    const snap = await backend.snapshot(id);
    await backend.button(id, 'back');

    const png = Buffer.from(snap.screenshot.base64, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20); // IHDR
    expect(snap.atomic, snap.detail).toBe(true);
    expect(snap.root.rect).toEqual({ x: 0, y: 0, width, height });
    // 화면이 꺼져 검은 PNG(~16KB)가 트리와 함께 "원자" 로 통과하는 일을 막는다: 실제 화면은 수백 KB 이상이고,
    // 트리에는 화면 안에 놓인 이름 있는 리프가 여럿 있어야 한다.
    expect(png.length, '거의 검은 스크린샷(화면 꺼짐?)').toBeGreaterThan(300_000);
    const leaves: Array<{ name?: string; text?: string; rect?: { x: number; y: number; width: number; height: number } }> = [];
    const collect = (n: typeof snap.root) => { if (!n.children?.length) leaves.push(n); for (const c of n.children ?? []) collect(c); };
    collect(snap.root);
    const named = leaves.filter((l) => (l.name || l.text) && l.rect && l.rect.width > 0 && l.rect.x + l.rect.width <= width && l.rect.y + l.rect.height <= height);
    expect(named.length).toBeGreaterThanOrEqual(3);

    const dir = path.resolve(import.meta.dirname, '../../../.e2e/device-proof');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `${stamp}-snapshot.png`), png);
    await fs.writeFile(path.join(dir, `${stamp}-snapshot.json`), JSON.stringify({ ...snap, screenshot: { format: 'png', bytes: png.length } }, null, 2));
    // 리포에 남는 요약(.e2e 는 git-ignore). 마지막 실행 하나만 유지한다.
    const summaryDir = path.resolve(import.meta.dirname, '../../../.scratch/android-backend/evidence');
    await fs.mkdir(summaryDir, { recursive: true });
    await fs.writeFile(path.join(summaryDir, '05-snapshot-latest.json'), JSON.stringify({
      device: `${info.model} (${id}) Android ${info.osVersion}`, helper: info.helper, capturedAt: snap.capturedAt, atomic: snap.atomic,
      png: { bytes: png.length, width, height }, rootRect: snap.root.rect, leaves: leaves.length, namedLeavesInScreen: named.length,
      sampleLeaves: named.slice(0, 5).map((l) => ({ label: l.name ?? l.text, rect: l.rect })),
    }, null, 2) + '\n');
  }, APPROVAL_WAIT_MS + 20_000);
});
