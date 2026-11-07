// @vitest-environment node
/**
 * 실기기(opt-in): 헬퍼를 지운 기기에서 `run` 이 APK 해석 → 설치 → 접근성 활성화 → 테스트 통과까지 혼자 가는지 본다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_TEST_REINSTALL=1 npx vitest run apps/runner-agent/test/helper-reinstall.device.test.ts
 * 전제: 기기 잠금 해제, 리포 디버그 빌드(android-helper README) 또는 SINCLAIR_AGENT_HELPER_APK.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Dadb } from '@sinclair/device-layer'; // 백엔드는 셸을 공개하지 않으므로 직접 ADB 로 지운다
import { startControlPlane, type CycleView } from '@sinclair/control-plane';
import { runOnce, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const reinstall = process.env.SINCLAIR_TEST_REINSTALL;
/** 처음 보는 호스트 키면 "USB 디버깅 허용" 승인 대기 60초 */
const APPROVAL_WAIT_MS = 60_000;

describe.skipIf(!target || !reinstall)('실기기 헬퍼 재설치', () => {
  it('헬퍼를 지운 뒤 run 이 설치·온보딩하고 설정 앱 샘플이 통과한다', async () => {
    // 1) 헬퍼 제거(직접 USB)
    const devices = await Dadb.list({ includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS });
    const dadb = target === '1' ? devices[0]! : devices.find((d) => d.serial === target)!;
    const serial = dadb.serial;
    try {
      const r = await dadb.shell('pm uninstall io.sinclair.helper');
      expect(r.allOutput).toMatch(/Success|not installed|Unknown package|DELETE_FAILED_INTERNAL_ERROR/);
    } finally { await dadb.close(); }

    // 2) 에이전트 run (mobile): APK 해석 → 온보딩 → 테스트
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'reinstall', build: 'b', targets: ['android'] }) });
      const code = await runOnce({
        controlPlane: url, cycle: 'reinstall', target: 'android', engine: 'mobile', app: 'com.android.settings', tests: path.resolve(import.meta.dirname, 'fixtures/device'),
        spool: path.resolve(import.meta.dirname, '../../../.e2e/agent-spool'), helperCache: path.resolve(import.meta.dirname, '../../../.e2e/helper-cache'), ...(target !== '1' ? { device: target! } : {}),
      }, { log: (l) => logs.push(l) });
      const view = (await (await fetch(`${url}/cycles/reinstall`)).json()) as CycleView;
      const dir = path.resolve(import.meta.dirname, '../../../.scratch/runner-agent/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '05-helper-reinstall-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), exitCode: code, cycle: { state: view.state, verdict: view.verdict },
        log: logs.map((l) => l.replaceAll(serial, `…${serial.slice(-4)}`)), // 오류 메시지에 섞이는 시리얼을 마스킹
      }, null, 2) + '\n');
      expect(logs.some((l) => /헬퍼 APK: .*\((flag|env|bundled|repo-build|cache|download)\)/.test(l))).toBe(true);
      expect(logs.some((l) => /헬퍼 ready/.test(l))).toBe(true);
      expect(code).toBe(EXIT.ok);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
    } finally { await cp.close(); }
  }, 240_000); // 승인 60초 + 설치·접근성 활성화·헬퍼 기동(~20초) + 테스트 + 여유
});
