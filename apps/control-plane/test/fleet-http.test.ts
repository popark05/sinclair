// @vitest-environment node
// Fleet HTTP: PUT /fleet/nodes/:agentId 로 노드 보고, GET /fleet 로 기기 상태. 시계 주입.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type FleetView } from '../src/index.ts';

let server: ControlPlaneServer;
let now = Date.parse('2026-11-08T00:00:00.000Z');
const TTL = 3_000;
beforeEach(async () => { now = Date.parse('2026-11-08T00:00:00.000Z'); server = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: TTL, now: () => now }); });
afterEach(async () => { await server.close(); });
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const put = (agentId: string, body: unknown) => fetch(url(`/fleet/nodes/${encodeURIComponent(agentId)}`), { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
const fleet = async () => (await (await fetch(url('/fleet'))).json()) as FleetView;
const device = { id: 'SER1', platform: 'android', model: 'SM-N981N', osVersion: '13', connection: 'device', helper: 'ready', locked: false };

describe('Fleet HTTP', () => {
  it('노드 보고는 200 과 ttlMs(다음 보고 간격의 기준)를 돌려주고, GET /fleet 에 기기 상태가 보인다', async () => {
    const res = await put('node-a', { devices: [device, { ...device, id: 'SER2', locked: true }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ttlMs: TTL });
    await put('node-b', { devices: [{ ...device, id: 'SER3', connection: 'unauthorized' }] });
    const v = await fleet();
    expect(v.nodeTtlMs).toBe(TTL);
    expect(v.nodes.map((n) => [n.agentId, n.online, n.devices.map((d) => [d.id, d.state, d.reason])])).toEqual([
      ['node-a', true, [['SER1', 'idle', undefined], ['SER2', 'untrusted', '화면 잠김']]],
      ['node-b', true, [['SER3', 'untrusted', 'USB 디버깅 미승인']]],
    ]);
  });

  it('보고가 TTL 을 넘기면 그 노드의 기기는 offline 이고, 다시 보고하면 돌아온다', async () => {
    await put('node-a', { devices: [device] });
    now += TTL;
    expect((await fleet()).nodes[0]).toMatchObject({ online: false, devices: [{ state: 'offline', reason: '노드 보고 끊김' }] });
    await put('node-a', { devices: [device] });
    expect((await fleet()).nodes[0]).toMatchObject({ online: true, devices: [{ state: 'idle' }] });
  });

  it('잘못된 보고는 400 과 검증 오류, 이전 보고는 그대로 남는다', async () => {
    await put('node-a', { devices: [device] });
    const bad = await put('node-a', { devices: [{ ...device, platform: 'windows' }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ errors: [expect.stringMatching(/platform/)] });
    expect((await fleet()).nodes[0]!.devices[0]!.state).toBe('idle');
    expect((await put('node-a', '{')).status).toBe(400);
  });
});
