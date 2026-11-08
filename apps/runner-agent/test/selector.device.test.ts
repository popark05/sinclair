// @vitest-environment node
/**
 * 실기기(opt-in): 조건 타깃. 꽂힌 기기의 모델·OS 로 만든 조건 타깃 Run 은 --targets 선언 없이 그 기기로 돌고,
 * 맞지 않는 조건(OS 99 이상)의 Run 은 받지 않는다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/selector.device.test.ts
 * 전제: 기기 잠금 해제, 설정 앱 제목이 "설정". 증거: .scratch/device-fleet/evidence/03-selector-device-latest.json (시리얼·경로 마스킹)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type CycleView, type FleetView } from '@sinclair/control-plane';
import { runDaemon, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const REPO = path.resolve(import.meta.dirname, '../../..');
const SERIALISH = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/g;
const tests = path.join(REPO, 'apps/runner-agent/test/fixtures/device');

describe.skipIf(!target)('실기기 · 조건 타깃', () => {
  it('기기의 모델·OS 에 맞는 조건 타깃 Run 은 선언 없이 그 기기로 돌고, 맞지 않는 조건은 대기한다', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode', leaseTtlMs: 6_000 });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    const post = (p: string, body: unknown) => fetch(`${url}${p}`, { method: 'POST', body: JSON.stringify(body) });
    try {
      // 1) 기기 속성을 알기 위해 Run 없이 데몬을 잠깐 돌려 Fleet 에 보고하게 한다
      await runDaemon({ controlPlane: url, targets: [], tests, engine: 'mobile', app: 'com.android.settings', spool: path.join(REPO, '.e2e/agent-spool-selector'), helperCache: path.join(REPO, '.e2e/helper-cache'), agent: 'sel-node', pollMs: 200, ...(target !== '1' ? { device: target! } : {}) }, { log: (l) => logs.push(l), signal: AbortSignal.timeout(3_000) });
      const dev = ((await (await fetch(`${url}/fleet`)).json()) as FleetView).nodes[0]!.devices.find((d) => (target !== '1' ? d.id === target : true))!;
      const major = dev.osVersion.split('.')[0]!;
      // 2) 이 기기에 맞는 조건과 맞지 않는 조건으로 Cycle
      await post('/cycles', { cycleId: 'sel', build: 'b', targets: [{ id: 'impossible', platform: 'android', osVersion: { min: '99' } }, { id: 'this-model', platform: 'android', model: dev.model, osVersion: { min: major, max: major } }], suite: { tests } });
      await post('/cycles/sel/runs', { targetId: 'impossible', runId: 'sel-impossible' });
      await post('/cycles/sel/runs', { targetId: 'this-model', runId: 'sel-model' });
      const summary = await runDaemon({ controlPlane: url, targets: [], tests, engine: 'mobile', app: 'com.android.settings', spool: path.join(REPO, '.e2e/agent-spool-selector'), helperCache: path.join(REPO, '.e2e/helper-cache'), agent: 'sel-node', pollMs: 200, ...(target !== '1' ? { device: target! } : {}) }, { log: (l) => logs.push(l), maxRuns: 1, signal: AbortSignal.timeout(60_000) }); // 받지 못하면 1분 뒤 멈추고 아래에서 실패를 알린다
      const view = (await (await fetch(`${url}/cycles/sel`)).json()) as CycleView;
      const mask = (l: string): string => l.split(dev.id).join(`…${dev.id.slice(-4)}`).split(REPO).join('<repo>').split(os.homedir()).join('<home>').replace(SERIALISH, (t) => `…${t.slice(-4)}`);
      const dir = path.join(REPO, '.scratch/device-fleet/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '03-selector-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), device: { id: `…${dev.id.slice(-4)}`, model: dev.model, osVersion: dev.osVersion },
        targetSelectors: view.targetSelectors, runs: view.runs.map((r) => ({ runId: r.runId, targetId: r.targetId, state: r.state, leasedThisDevice: r.lease?.deviceId === dev.id })),
        cycle: { state: view.state, verdict: view.verdict }, exitCodes: summary.runs.map((r) => r.exitCode), log: logs.map(mask),
      }, null, 2) + '\n');
      expect(summary.runs.map((r) => [r.runId, r.targetId, r.exitCode])).toEqual([['sel-model', 'this-model', EXIT.ok]]);
      expect(view.runs.find((r) => r.runId === 'sel-model')?.lease?.deviceId === dev.id).toBe(true);
      expect(view.runs.find((r) => r.runId === 'sel-impossible')).toMatchObject({ state: 'queued' });
      expect(view.runs.find((r) => r.runId === 'sel-impossible')!.lease).toBeUndefined();
    } finally {
      await cp.close();
    }
  }, 180_000);
});
