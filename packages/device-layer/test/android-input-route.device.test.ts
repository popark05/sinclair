// @vitest-environment node
/**
 * 실기기(opt-in): 탭이 접근성 제스처 경로와 adb shell 경로 양쪽에서 성공하고, 어느 경로를 탔는지 이벤트로 남는다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run packages/device-layer/test/android-input-route.device.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAndroidBackend, type InputRouteEvent } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const APPROVAL_WAIT_MS = 60_000;

async function runTap(preferShellInput: boolean) {
  const events: InputRouteEvent[] = [];
  const backend = createAndroidBackend({
    dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS,
    ...(preferShellInput ? { preferShellInput: true } : {}), onInput: (e) => events.push(e),
  });
  try {
    const [device] = await backend.listDevices();
    const id = target === '1' ? device!.id : target!;
    let info = await backend.info(id);
    for (let i = 0; i < 40 && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, 250)); info = await backend.info(id); }
    await backend.keys(id, ['KEYCODE_WAKEUP', 'KEYCODE_MENU']);
    await backend.button(id, 'home');
    await new Promise((r) => setTimeout(r, 500));
    const before = await backend.screenshot(id);
    // 홈 화면 하단 가운데(독/페이지 영역)를 탭해 무언가가 바뀌게 한다. 앱이 열리면 BACK/HOME 으로 되돌린다.
    await backend.button(id, 'back'); // 알림 패널 등이 열려 있으면 닫는다
    await new Promise((r) => setTimeout(r, 300));
    const tree = await backend.dumpUi(id);
    const candidates: Array<typeof tree> = [];
    (function walk(n: typeof tree) { if (n.role === 'button' && (n.name || n.text) && n.rect && n.rect.width > 0) candidates.push(n); for (const c of n.children ?? []) walk(c); })(tree);
    const height = tree.rect?.height ?? 0;
    const leaf = candidates.find((n) => n.rect!.y > height / 2) ?? candidates[0];
    const summary = (function roles(n: typeof tree, acc: Record<string, number>) { acc[n.role] = (acc[n.role] ?? 0) + 1; for (const c of n.children ?? []) roles(c, acc); return acc; })(tree, {});
    expect(leaf, `탭할 버튼이 화면에 없음. roles=${JSON.stringify(summary)}`).toBeDefined();
    const x = leaf!.rect!.x + leaf!.rect!.width / 2, y = leaf!.rect!.y + leaf!.rect!.height / 2;
    await backend.tap(id, { x: Math.round(x), y: Math.round(y) });
    await new Promise((r) => setTimeout(r, 1200));
    const after = await backend.screenshot(id);
    await backend.button(id, 'back');
    await backend.button(id, 'home');
    return { id, info, events, target: leaf!.name ?? leaf!.text, changed: !Buffer.from(before).equals(Buffer.from(after)) };
  } finally {
    await backend.close();
  }
}

describe.skipIf(!target)('실기기 입력 경로', () => {
  it('헬퍼 경로(접근성 제스처)와 shell 경로(preferShellInput) 모두 탭이 화면을 바꾸고, 경로가 이벤트로 남는다', async () => {
    const viaHelper = await runTap(false);
    expect(viaHelper.info.helper?.state).toBe('ready');
    expect(viaHelper.events.find((e) => e.action === 'tap')).toMatchObject({ route: 'helper' });
    expect(viaHelper.changed, '헬퍼 경로 탭 뒤 화면이 바뀌지 않음').toBe(true);

    const viaShell = await runTap(true);
    expect(viaShell.events.find((e) => e.action === 'tap')).toMatchObject({ route: 'shell', fallbackReason: expect.stringContaining('preferShellInput') });
    expect(viaShell.changed, 'shell 경로 탭 뒤 화면이 바뀌지 않음').toBe(true);

    const dir = path.resolve(import.meta.dirname, '../../../.scratch/android-backend/evidence');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '06-input-route-latest.json'), JSON.stringify({
      device: `${viaHelper.info.model} (${viaHelper.id}) Android ${viaHelper.info.osVersion}`, helper: viaHelper.info.helper, at: new Date().toISOString(),
      helperRoute: { target: viaHelper.target, events: viaHelper.events.filter((e) => e.action === 'tap'), screenChanged: viaHelper.changed },
      shellRoute: { target: viaShell.target, events: viaShell.events.filter((e) => e.action === 'tap'), screenChanged: viaShell.changed },
    }, null, 2) + '\n');
  }, APPROVAL_WAIT_MS * 2 + 30_000);
});
