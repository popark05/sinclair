// @vitest-environment node
/**
 * 실기기(opt-in, 잠긴 기기 전용): 보안 잠금이 걸린 기기는 클레임 후보에서 빠져 Run 을 받지 않는다(blocked 로 끝나는 대신 대기).
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet-locked.device.test.ts
 * 전제: 기기가 **잠긴 상태**(화면 꺼짐 + PIN/패턴 등 보안 잠금). 잠금이 풀려 있으면 실패로 알린다(그 경로는 fleet.device.test.ts).
 * 증거: .scratch/device-fleet/evidence/05-locked-device-latest.json (시리얼·경로 마스킹)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type CycleView, type FleetView } from '@sinclair/control-plane';
import { runDaemon } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const REPO = path.resolve(import.meta.dirname, '../../..');
/** 데몬이 클레임을 몇 번 돌 시간(폴링 200ms) + 잠긴 기기 풀기 시도 1회(약 1초) */
const WATCH_MS = 12_000;

describe.skipIf(!target)('실기기 · 잠긴 기기는 Run 을 받지 않는다', () => {
  it('보안 잠금 기기는 후보에서 빠지고 Fleet 에 untrusted(화면 잠김), Run 은 lease 없이 대기한다', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode', leaseTtlMs: 6_000 });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'locked', build: 'b', targets: ['android'], suite: { tests: path.join(REPO, 'apps/runner-agent/test/fixtures/device') } }) });
      await fetch(`${url}/cycles/locked/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'locked-run' }) });
      const summary = await runDaemon(
        { controlPlane: url, targets: ['android'], tests: path.join(REPO, 'apps/runner-agent/test/fixtures/device'), engine: 'mobile', app: 'com.android.settings', spool: path.join(REPO, '.e2e/agent-spool-locked'), helperCache: path.join(REPO, '.e2e/helper-cache'), agent: 'locked-node', pollMs: 200, ...(target !== '1' ? { device: target! } : {}) },
        { log: (l) => logs.push(l), signal: AbortSignal.timeout(WATCH_MS) },
      );
      const fleet = (await (await fetch(`${url}/fleet`)).json()) as FleetView;
      const view = (await (await fetch(`${url}/cycles/locked`)).json()) as CycleView;
      const node = fleet.nodes.find((n) => n.agentId === 'locked-node');
      const serials = node?.devices.map((d) => d.id) ?? [];
      const mask = (l: string): string => serials.reduce((x, id) => x.split(id).join(`…${id.slice(-4)}`), l.split(REPO).join('<repo>').split(os.homedir()).join('<home>'));
      const dir = path.join(REPO, '.scratch/device-fleet/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '05-locked-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), watchedMs: WATCH_MS,
        node: node && { agentId: node.agentId, devices: node.devices.map((d) => ({ id: `…${d.id.slice(-4)}`, model: d.model, connection: d.connection, helper: d.helper, locked: d.locked, state: d.state, reason: d.reason })) },
        runsTaken: summary.runs.length, cycleRun: { state: view.runs[0]?.state, leased: !!view.runs[0]?.lease }, log: logs.map(mask),
      }, null, 2) + '\n');
      expect(node?.devices[0]?.locked, '기기가 잠긴 상태여야 한다(잠금이 풀려 있으면 fleet.device.test.ts 로 확인)').toBe(true);
      const { id: _id, ...first } = node!.devices[0]!;
      expect(first).toMatchObject({ state: 'untrusted', reason: '화면 잠김' });
      expect(summary.runs).toEqual([]); // Run 을 받지 않았다
      expect(view.runs[0]).toMatchObject({ runId: 'locked-run', state: 'queued' });
      expect(view.runs[0]!.lease).toBeUndefined();
      expect(logs.filter((l) => /후보에서 뺌: 화면 잠김/.test(l))).toHaveLength(1);
    } finally {
      await cp.close();
    }
  }, 120_000);
});
