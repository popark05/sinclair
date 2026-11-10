// @vitest-environment node
/**
 * 실기기(opt-in): keyboard.shown 이 화면 키보드 표시를 따라간다 — 설정 검색창을 누르면 true, 내리면 false.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run packages/engine-mobile/test/keyboard.device.test.ts
 * 2026-11-10 SM-N981N(Android 13): false → true → false.
 */
import { describe, it, expect } from 'vitest';
import { createAndroidBackend, createDeviceServer } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '../src/index.ts';

describe.skipIf(!process.env.SINCLAIR_TEST_USB)('실기기 keyboard.shown', () => {
  it('설정 검색창을 누르면 키보드가 떠 true, dismiss 뒤 false', async () => {
    const backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: 60_000 }, probeWaitMs: 60_000 });
    try {
      const [d] = await backend.listDevices();
      const id = process.env.SINCLAIR_TEST_USB === '1' ? d!.id : process.env.SINCLAIR_TEST_USB!;
      let info = await backend.info(id);
      for (let i = 0; i < 40 && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, 250)); info = await backend.info(id); }
      await backend.keys(id, ['KEYCODE_WAKEUP']);
      const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([backend])), { deviceId: id, appId: 'com.android.settings' });
      await engine.session!.open();
      await new Promise((r) => setTimeout(r, 1500));
      const before = await engine.keyboard!.shown!();
      const [search] = await engine.locate({ role: 'button', name: '설정 검색' });
      await engine.perform(search!.ref, 'tap');
      await new Promise((r) => setTimeout(r, 2000)); // 검색 화면 전환 + 키보드 애니메이션
      const after = await engine.keyboard!.shown!();
      await engine.keyboard!.dismiss();
      await new Promise((r) => setTimeout(r, 1000));
      const dismissed = await engine.keyboard!.shown!();
      await backend.terminateApp(id, 'com.android.settings').catch(() => undefined);
      await backend.button(id, 'home').catch(() => undefined);
      expect([before, after, dismissed]).toEqual([false, true, false]);
    } finally {
      await backend.close();
    }
  }, 120_000);
});
