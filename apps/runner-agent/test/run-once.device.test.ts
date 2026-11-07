// @vitest-environment node
/**
 * 실기기(opt-in): 설정 앱 샘플을 engine mobile 로 돌려 인프로세스 control-plane 까지 흐른 증거를 남긴다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/run-once.device.test.ts
 * 전제: 기기 잠금 해제, 헬퍼 APK 설치, 설정 앱 제목이 "설정"(한국어 UI).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { startControlPlane, type CycleView } from '@sinclair/control-plane';
import { runOnce, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;

describe.skipIf(!target)('실기기 sinclair-agent run', () => {
  it('설정 앱 샘플이 실기기 → control-plane 까지 흐르고 Cycle 이 verified 다', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: '' });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'device', build: 'b', targets: ['android'] }) });
      const code = await runOnce({
        controlPlane: url, cycle: 'device', target: 'android', engine: 'mobile', app: 'com.android.settings',
        tests: path.resolve(import.meta.dirname, 'fixtures/device'), ...(target !== '1' ? { device: target! } : {}),
      }, { log: (l) => logs.push(l) });
      const view = (await (await fetch(`${url}/cycles/device`)).json()) as CycleView & { runs: Array<{ runId: string }> };
      const runView = await (await fetch(`${url}/runs/${view.runs[0]!.runId}`)).json() as { deviceId?: string; attempts: Array<{ testId?: string; result?: string; steps: unknown[] }> };
      const dir = path.resolve(import.meta.dirname, '../../../.scratch/runner-agent/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '02-run-once-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), exitCode: code, device: runView.deviceId, cycle: { state: view.state, verdict: view.verdict, matrix: view.matrix },
        attempts: runView.attempts.map((a) => ({ testId: a.testId, result: a.result, steps: a.steps.length })), log: logs,
      }, null, 2) + '\n');
      expect(code).toBe(EXIT.ok);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
    } finally {
      await cp.close();
    }
  }, 180_000);
});
