// @vitest-environment node
/**
 * 실기기(opt-in): 설정 앱 샘플을 engine mobile 로 돌려 인프로세스 control-plane 까지 흐른 증거를 남긴다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/run-once.device.test.ts
 * 전제: 기기 잠금 해제, 헬퍼 APK 설치, 설정 앱 제목이 "설정"(한국어 UI).
 * 두 번째 Cycle 은 `retries: 1` 로 첫 시도만 실패하는 샘플(fixtures/device-flaky)을 돌려 Cycle 매트릭스의 `passed-flaky` 셀을 증거로 남긴다.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { startControlPlane, type CycleView } from '@sinclair/control-plane';
import { runOnce, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;

describe.skipIf(!target)('실기기 sinclair-agent run', () => {
  it('설정 앱 샘플이 실기기 → control-plane 까지 흐르고 Cycle 이 verified 다', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'device', build: 'b', targets: ['android'] }) });
      const code = await runOnce({
        controlPlane: url, cycle: 'device', target: 'android', engine: 'mobile', app: 'com.android.settings',
        tests: path.resolve(import.meta.dirname, 'fixtures/device'), spool: path.resolve(import.meta.dirname, '../../../.e2e/agent-spool'), helperCache: path.resolve(import.meta.dirname, '../../../.e2e/helper-cache'), ...(target !== '1' ? { device: target! } : {}),
      }, { log: (l) => logs.push(l) });
      const view = (await (await fetch(`${url}/cycles/device`)).json()) as CycleView & { runs: Array<{ runId: string }> };
      const runView = await (await fetch(`${url}/runs/${view.runs[0]!.runId}`)).json() as { deviceId?: string; agentId?: string; attempts: Array<{ testId?: string; result?: string; steps: unknown[] }> };
      const masked = runView.deviceId ? `…${runView.deviceId.slice(-4)}` : undefined; // 증거에는 시리얼을 마스킹한다
      const dir = path.resolve(import.meta.dirname, '../../../.scratch/runner-agent/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '02-run-once-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), exitCode: code, device: masked, agentId: runView.agentId ? '(호스트명, 생략)' : undefined, cycle: { state: view.state, verdict: view.verdict, matrix: view.matrix },
        attempts: runView.attempts.map((a) => ({ testId: a.testId, result: a.result, steps: a.steps.length })), log: logs,
      }, null, 2) + '\n');
      expect(code).toBe(EXIT.ok);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });

      // 재시도: 같은 기기에서 첫 시도만 실패하는 샘플을 --retries 1 로 → control-plane 매트릭스 셀이 passed-flaky
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'device-retry', build: 'b', targets: ['android'] }) });
      const retryLogs: string[] = [];
      const retryCode = await runOnce({
        controlPlane: url, cycle: 'device-retry', target: 'android', engine: 'mobile', app: 'com.android.settings', retries: 1, timeoutMs: 5_000,
        tests: path.resolve(import.meta.dirname, 'fixtures/device-flaky'), spool: path.resolve(import.meta.dirname, '../../../.e2e/agent-spool'), helperCache: path.resolve(import.meta.dirname, '../../../.e2e/helper-cache'), ...(target !== '1' ? { device: target! } : {}),
      }, { log: (l) => retryLogs.push(l) });
      const retryView = (await (await fetch(`${url}/cycles/device-retry`)).json()) as CycleView & { runs: Array<{ runId: string }> };
      const retryRun = await (await fetch(`${url}/runs/${retryView.runs[0]!.runId}`)).json() as { attempts: Array<{ testId?: string; attemptNo?: number; result?: string }> };
      await fs.writeFile(path.join(dir, '02-run-once-retry-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), exitCode: retryCode, device: masked, retries: 1, cycle: { state: retryView.state, verdict: retryView.verdict, matrix: retryView.matrix },
        attempts: retryRun.attempts.map((a) => ({ testId: a.testId, attemptNo: a.attemptNo, result: a.result })), log: retryLogs,
      }, null, 2) + '\n');
      expect(retryCode).toBe(EXIT.ok);
      expect(retryView).toMatchObject({ state: 'finished', verdict: 'verified' });
      expect(Object.values(retryView.matrix)[0]!.android).toMatchObject({ verdict: 'passed-flaky' });
    } finally {
      await cp.close();
    }
  }, 180_000); // USB 디버깅 승인 60초 + 헬퍼 온보딩 10초 + 설정 앱 테스트 + 여유
});
