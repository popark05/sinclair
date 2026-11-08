// @vitest-environment node
// 기기 lease HTTP: 클레임이 후보 기기를 받아 lease 에 싣고, Fleet 은 leased 로 보이며, run.finished 가 들어오면 기기가 바로 풀린다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type CycleView, type FleetView } from '../src/index.ts';
import { base } from './fixtures.ts';

let server: ControlPlaneServer;
let now = Date.parse('2026-11-08T00:00:00.000Z');
beforeEach(async () => { now = Date.parse('2026-11-08T00:00:00.000Z'); server = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 60_000, now: () => now }); });
afterEach(async () => { await server.close(); });
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: 'POST', body: JSON.stringify(body) });
const claim = async (body: unknown) => { const r = await post('/runs/claim', body); return r.status === 200 ? (await r.json()) as { run: { runId: string; lease: { deviceId?: string } }; warning?: string } : undefined; };
const device = (id: string) => ({ id, platform: 'android', model: 'SM-N981N', osVersion: '13', connection: 'device', helper: 'ready', locked: false });

describe('기기 lease (HTTP)', () => {
  beforeEach(async () => {
    await post('/cycles', { cycleId: 'c', build: 'b', targets: ['android'] });
    await post('/cycles/c/runs', { targetId: 'android', runId: 'r1' });
    await post('/cycles/c/runs', { targetId: 'android', runId: 'r2' });
  });

  it('클레임이 후보 기기 중 빈 기기를 lease 하고, Fleet 에 leased(runId)로 보이며, run.finished 가 들어오면 바로 풀린다', async () => {
    await fetch(url('/fleet/nodes/n'), { method: 'PUT', body: JSON.stringify({ devices: [device('D1')] }) });
    const a = await claim({ targetId: 'android', agentId: 'n', devices: ['D1'] });
    expect(a).toMatchObject({ run: { runId: 'r1', lease: { deviceId: 'D1' } } });
    expect(a!.warning).toBeUndefined();
    expect(await claim({ targetId: 'android', agentId: 'n', devices: ['D1'] })).toBeUndefined(); // D1 바쁨 → r2 는 대기
    const f = (await (await fetch(url('/fleet'))).json()) as FleetView;
    expect(f.nodes[0]!.devices[0]).toMatchObject({ id: 'D1', state: 'leased', runId: 'r1' });
    // r1 이 끝났다고 보고하면 lease 만료를 기다리지 않고 풀린다
    await post('/ingest', [{ ...base('e0', 0, 'r1'), type: 'run.started', cycleId: 'c', targetId: 'android', deviceId: 'D1' }, { ...base('e1', 1, 'r1'), type: 'run.finished', state: 'finished' }] satisfies RunEvent[]);
    expect(((await (await fetch(url('/fleet'))).json()) as FleetView).nodes[0]!.devices[0]).toMatchObject({ state: 'idle' });
    expect(await claim({ targetId: 'android', agentId: 'n', devices: ['D1'] })).toMatchObject({ run: { runId: 'r2', lease: { deviceId: 'D1' } } });
  });

  it('devices 없이 클레임하는 구버전 에이전트는 기기 없는 lease 와 경고를 받는다; devices 는 문자열 배열이어야 한다', async () => {
    const legacy = await claim({ targetId: 'android', agentId: 'old' });
    expect(legacy).toMatchObject({ run: { runId: 'r1' }, warning: expect.stringMatching(/기기/) });
    expect(legacy!.run.lease.deviceId).toBeUndefined();
    expect((await post('/runs/claim', { targetId: 'android', agentId: 'n', devices: 'D1' })).status).toBe(400);
  });

  it('run.started.deviceId 가 lease 된 기기와 다르면 Cycle 뷰 warnings', async () => {
    await claim({ targetId: 'android', agentId: 'n', devices: ['D1'] });
    await post('/ingest', [{ ...base('e0', 0, 'r1'), type: 'run.started', cycleId: 'c', targetId: 'android', deviceId: 'D9' }] satisfies RunEvent[]);
    const v = (await (await fetch(url('/cycles/c'))).json()) as CycleView & { warnings?: string[] };
    expect(v.warnings).toEqual([expect.stringMatching(/r1.*deviceId.*D9.*lease.*D1/)]);
  });
});
