// @vitest-environment node
/**
 * 실기기(opt-in): 샘플 테스트 파일을 engine-mobile 로 실제 Android 기기에서 돌린다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run packages/runner/test/runner.device.test.ts
 * 전제: 기기 잠금 해제, 설정 앱(com.android.settings) 제목이 "설정"(한국어 UI).
 * 두 번째 테스트는 재시도(retries 1): 첫 시도만 실패하는 샘플이 passed/attempts 2 로 끝나고 이벤트에 attemptNo 1·2 가 남는다(evidence 05-runner-retry-device-latest.json).
 */
import { describe, it, expect as vexpect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAndroidBackend, createDeviceServer } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '@sinclair/engine-mobile';
import { runTests } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
/** 처음 보는 호스트 키면 "USB 디버깅 허용" 을 사람이 눌러야 하므로 승인 대기를 60초 준다. */
const APPROVAL_WAIT_MS = 60_000;
const PENDING_POLL_MS = 250;
const PENDING_POLLS = 40;

describe.skipIf(!target)('실기기 runTests', () => {
  it('샘플 테스트(설정 앱 열기 → "설정" 제목)가 통과하고 요약이 evidence 에 남는다', async () => {
    const backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS });
    try {
      const [device] = await backend.listDevices();
      const deviceId = target === '1' ? device!.id : target!;
      let info = await backend.info(deviceId);
      for (let i = 0; i < PENDING_POLLS && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, PENDING_POLL_MS)); info = await backend.info(deviceId); }
      vexpect(info.helper?.state).toBe('ready');
      await backend.keys(deviceId, ['KEYCODE_WAKEUP']);
      const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([backend])), { deviceId, appId: 'com.android.settings' });
      const artifactsDir = path.resolve(import.meta.dirname, '../../../.e2e/runner-artifacts');
      const report = await runTests([path.resolve(import.meta.dirname, 'fixtures/sample.sinclair.ts')], { engine, artifactsDir, deviceId: `…${deviceId.slice(-4)}` });
      const dir = path.resolve(import.meta.dirname, '../../../.scratch/runner-locator/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '05-runner-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), device: `${info.model} (…${deviceId.slice(-4)}) Android ${info.osVersion}`, summary: report.summary,
        tests: report.tests.map((t) => ({ name: t.name, result: t.result, durationMs: t.durationMs, steps: t.steps.map((s) => ({ kind: s.kind, instruction: s.instruction, durationMs: s.durationMs })), error: t.error })),
      }, null, 2) + '\n');
      vexpect(report.summary).toEqual({ passed: 1, failed: 0, blocked: 0, skipped: 0 });

      // 재시도: 첫 시도만 실패하는 샘플. 실패 시도 아티팩트는 그 attemptId 로 남고, 두 번째 시도가 통과한다
      const retry = await runTests([path.resolve(import.meta.dirname, 'fixtures/sample-flaky.sinclair.ts')], { engine, artifactsDir, retries: 1, timeoutMs: 5_000, deviceId: `…${deviceId.slice(-4)}` });
      const attempts = retry.events.filter((e) => e.type === 'attempt.started' || e.type === 'attempt.finished').map((e) => e.type === 'attempt.started' ? { type: e.type, attemptNo: e.attemptNo, attemptId: e.attemptId } : { type: e.type, result: e.result, attemptId: e.attemptId, artifacts: e.artifacts.map((a) => a.kind) });
      await fs.writeFile(path.join(dir, '05-runner-retry-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), device: `${info.model} (…${deviceId.slice(-4)}) Android ${info.osVersion}`, retries: 1, summary: retry.summary,
        tests: retry.tests.map((t) => ({ name: t.name, result: t.result, attempts: t.attempts, durationMs: t.durationMs })), attempts,
      }, null, 2) + '\n');
      vexpect(retry.tests.map((t) => [t.result, t.attempts])).toEqual([['passed', 2]]);
      vexpect(attempts.map((a) => ('attemptNo' in a ? `started ${a.attemptNo}` : `finished ${a.result}`))).toEqual(['started 1', 'finished failed', 'started 2', 'finished passed']);
      await engine.session!.restart().catch(() => undefined);
      await backend.terminateApp(deviceId, 'com.android.settings').catch(() => undefined);
      await backend.button(deviceId, 'home').catch(() => undefined);
    } finally {
      await backend.close();
    }
  }, APPROVAL_WAIT_MS + 60_000);
});
