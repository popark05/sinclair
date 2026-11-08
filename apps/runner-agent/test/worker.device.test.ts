// @vitest-environment node
/**
 * 실기기(opt-in): 워커 모드 데몬 — 데몬이 USB 를 소유하고 기기를 준비한 뒤, 별도 워커 프로세스가 데몬의 디바이스 RPC(127.0.0.1 HTTP, 토큰)로만 실기기를 돌린다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/worker.device.test.ts
 * 전제: 기기 잠금 해제(또는 화면 켜짐 상태 유지), 설정 앱 제목이 "설정". 기기가 한 대라 동시성은 daemon-workers.test.ts(가짜 기기 3대)가 증명한다.
 * 증거: .scratch/device-fleet/evidence/04-worker-device-latest.json (시리얼·경로 마스킹)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type CycleView } from '@sinclair/control-plane';
import { runDaemon, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const REPO = path.resolve(import.meta.dirname, '../../..');
const BIN = path.join(REPO, 'apps/runner-agent/bin/sinclair-agent.mjs');
const WORKER = [process.execPath, '--experimental-transform-types', '--no-warnings=ExperimentalWarning', BIN];
const SERIALISH = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/g;
const tests = path.join(REPO, 'apps/runner-agent/test/fixtures/device');

describe.skipIf(!target)('실기기 · 워커 모드 데몬', () => {
  it('워커 프로세스가 데몬의 디바이스 RPC 로 실기기 Run 을 끝낸다', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode', leaseTtlMs: 6_000 });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    const pids: number[] = [];
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'wk', build: 'b', targets: ['android'], suite: { tests } }) });
      await fetch(`${url}/cycles/wk/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'wk-run' }) });
      const summary = await runDaemon(
        { controlPlane: url, targets: ['android'], tests, engine: 'mobile', app: 'com.android.settings', spool: path.join(REPO, '.e2e/agent-spool-worker'), helperCache: path.join(REPO, '.e2e/helper-cache'), agent: 'worker-node', pollMs: 200, ...(target !== '1' ? { device: target! } : {}) },
        { log: (l) => logs.push(l), maxRuns: 1, workerCommand: WORKER, onWorkerSpawn: (_r, pid) => pids.push(pid), signal: AbortSignal.timeout(120_000) },
      );
      const view = (await (await fetch(`${url}/cycles/wk`)).json()) as CycleView & { warnings?: string[] };
      const runView = (await (await fetch(`${url}/runs/wk-run`)).json()) as { deviceId?: string };
      const leased = view.runs[0]?.lease?.deviceId;
      const mask = (l: string): string => (leased ? l.split(leased).join(`…${leased.slice(-4)}`) : l).split(REPO).join('<repo>').split(os.homedir()).join('<home>').replace(SERIALISH, (t) => `…${t.slice(-4)}`);
      const dir = path.join(REPO, '.scratch/device-fleet/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '04-worker-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), workerPids: pids.length, workerIsSeparateProcess: pids.length === 1 && pids[0] !== process.pid,
        run: { exitCodes: summary.runs.map((r) => r.exitCode), cycle: { state: view.state, verdict: view.verdict, warnings: view.warnings }, leasedDevice: leased && `…${leased.slice(-4)}`, startedOnLeasedDevice: !!leased && runView.deviceId === leased },
        log: logs.map(mask),
      }, null, 2) + '\n');
      expect(summary.runs.map((r) => r.exitCode)).toEqual([EXIT.ok]);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
      expect(pids).toHaveLength(1);
      expect(pids[0]).not.toBe(process.pid);
      expect(runView.deviceId === leased).toBe(true);
      expect(view.warnings).toBeUndefined();
      expect(logs.some((l) => /^\[run …/.test(l) && /결과: passed 1/.test(l))).toBe(true); // 결과 줄이 워커에서 왔다
    } finally {
      await cp.close();
    }
  }, 180_000);
});
