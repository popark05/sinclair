// @vitest-environment node
/**
 * 실기기(opt-in) Fleet 종단(device-fleet 06): mobile 데몬(실기기, 워커 모드)과 fake 데몬을 한 control-plane 에 붙이고,
 * 실기기 모델·OS 조건 타깃과 FakeEngine 조건 타깃을 한 Cycle 에 넣는다 → 두 열이 각자 노드에서 채워져 verified, 실기기는 Fleet 에 idle → leased → idle.
 * 잠금 → untrusted 는 같은 기기로 05 에서 증명했다(.scratch/device-fleet/evidence/05-locked-device-latest.json).
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet-e2e.device.test.ts
 * 전제: 기기 잠금 해제(또는 화면 켜짐 상태 유지). 증거: .scratch/device-fleet/evidence/06-device-latest.json (시리얼·경로 마스킹)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type CycleView, type FleetView } from '@sinclair/control-plane';
import { runDaemon, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const REPO = path.resolve(import.meta.dirname, '../../..');
const WORKER = [process.execPath, '--experimental-transform-types', '--no-warnings=ExperimentalWarning', path.join(REPO, 'apps/runner-agent/bin/sinclair-agent.mjs')];
const SUITE = path.join(REPO, 'apps/runner-agent/test/fixtures/fleet-mixed');
const SERIALISH = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/g;
const until = async <T>(what: string, cond: () => Promise<T | undefined>, limitMs: number): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await cond(); if (v !== undefined) return v; if (Date.now() - t > limitMs) throw new Error(`시간 초과: ${what}`); await new Promise((r) => setTimeout(r, 200)); }
};

describe.skipIf(!target)('실기기 · Fleet 종단', () => {
  it('실기기 노드와 가짜 노드가 조건 타깃 Cycle 의 두 열을 각각 채우고, 실기기는 idle → leased → idle', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode', leaseTtlMs: 6_000 });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const fleet = async () => (await (await fetch(`${url}/fleet`)).json()) as FleetView;
    const logs: string[] = [];
    const aborter = new AbortController();
    const common = { controlPlane: url, targets: [], tests: SUITE, pollMs: 200, helperCache: path.join(REPO, '.e2e/helper-cache') };
    const daemons = [
      runDaemon({ ...common, engine: 'mobile', app: 'com.android.settings', agent: 'real-node', spool: path.join(REPO, '.e2e/agent-spool-fleet-real'), ...(target !== '1' ? { device: target! } : {}) }, { log: (l) => logs.push(`[real] ${l}`), workerCommand: WORKER, signal: aborter.signal }),
      runDaemon({ ...common, engine: 'fake', agent: 'fake-node', spool: path.join(REPO, '.e2e/agent-spool-fleet-fake') }, { log: (l) => logs.push(`[fake] ${l}`), workerCommand: WORKER, signal: aborter.signal }),
    ];
    let real: FleetView['nodes'][number]['devices'][number] | undefined;
    let leasedSeen: unknown;
    let evidence: Record<string, unknown> = {};
    try {
      // 두 노드가 보고할 때까지
      real = await until('실기기 노드 보고', async () => (await fleet()).nodes.find((n) => n.agentId === 'real-node')?.devices.find((d) => (target !== '1' ? d.id === target : true)), 90_000);
      await until('가짜 노드 보고', async () => (await fleet()).nodes.find((n) => n.agentId === 'fake-node') ?? undefined, 20_000);
      const idleBefore = real.state;
      const major = real.osVersion.split('.')[0]!;
      const targets = [{ id: 'real-model', platform: 'android', model: real.model, osVersion: { min: major, max: major } }, { id: 'fake-model', platform: 'android', model: 'FakeEngine' }];
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'fleet-real', build: 'b', targets, suite: { tests: SUITE } }) });
      for (const t of targets) await fetch(`${url}/cycles/fleet-real/runs`, { method: 'POST', body: JSON.stringify({ targetId: t.id, runId: `fleet-real-${t.id}` }) });
      leasedSeen = await until('실기기가 leased', async () => { const d = (await fleet()).nodes.find((n) => n.agentId === 'real-node')?.devices.find((x) => x.id === real!.id); return d?.state === 'leased' ? { state: d.state, runId: d.runId } : undefined; }, 60_000);
      const view = await until('Cycle finished', async () => { const v = (await (await fetch(`${url}/cycles/fleet-real`)).json()) as CycleView; return v.state === 'finished' ? v : undefined; }, 120_000);
      const idleAfter = await until('실기기가 다시 idle', async () => { const d = (await fleet()).nodes.find((n) => n.agentId === 'real-node')?.devices.find((x) => x.id === real!.id); return d?.state === 'idle' ? d.state : undefined; }, 20_000);
      const rows = view.runs.map((r) => ({ runId: r.runId, targetId: r.targetId, state: r.state, agent: r.lease?.agentId, onRealDevice: r.lease?.deviceId === real!.id, ...(r.lease?.deviceId && r.lease.deviceId !== real!.id ? { deviceId: r.lease.deviceId } : {}) }));
      evidence = { device: { id: `…${real.id.slice(-4)}`, model: real.model, osVersion: real.osVersion }, fleetStates: { before: idleBefore, during: leasedSeen, after: idleAfter }, cycle: { state: view.state, verdict: view.verdict, runs: rows, cells: Object.fromEntries(Object.entries(view.matrix).map(([t, row]) => [t, Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c.verdict]))])) } };
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
      expect(rows.find((r) => r.targetId === 'real-model')).toMatchObject({ state: 'finished', agent: 'real-node', onRealDevice: true });
      expect(rows.find((r) => r.targetId === 'fake-model')).toMatchObject({ state: 'finished', agent: 'fake-node', onRealDevice: false });
      expect([idleBefore, (leasedSeen as { state: string }).state, idleAfter]).toEqual(['idle', 'leased', 'idle']);
    } finally {
      aborter.abort();
      const summaries = await Promise.allSettled(daemons);
      // 노드가 보고하지 않아 real 이 없어도 지정한 시리얼(SINCLAIR_TEST_USB)은 지운다
      const serials = [real?.id, target !== '1' ? target : undefined].filter((x): x is string => !!x);
      const mask = (l: string): string => serials.reduce((x, id) => x.split(id).join(`…${id.slice(-4)}`), l).split(REPO).join('<repo>').split(os.homedir()).join('<home>').replace(SERIALISH, (t) => `…${t.slice(-4)}`);
      const dir = path.join(REPO, '.scratch/device-fleet/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '06-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), ...evidence,
        daemonExitCodes: summaries.map((s) => (s.status === 'fulfilled' ? s.value.runs.map((r) => r.exitCode) : `error: ${String(s.reason)}`)),
        lockedProof: '.scratch/device-fleet/evidence/05-locked-device-latest.json', log: logs.map(mask),
      }, null, 2) + '\n');
      await cp.close();
    }
    for (const s of await Promise.allSettled(daemons)) {
      expect(s.status).toBe('fulfilled'); // 데몬이 예외로 끝났으면 여기서 드러난다
      if (s.status === 'fulfilled') expect(s.value.runs.map((r) => r.exitCode)).toEqual([EXIT.ok]);
    }
  }, 240_000);
});
