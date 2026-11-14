// @vitest-environment node
// Console → Studio 열기 요청(studio-console 05): Console 이 남기고, 그 기기가 연결된 Studio 가 가져가 처리(ack)한다. 메모리·10분.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer } from '../src/index.ts';

let server: ControlPlaneServer;
let now = Date.parse('2026-11-14T10:00:00Z');
beforeEach(async () => { now = Date.parse('2026-11-14T10:00:00Z'); server = await serveControlPlane(createMemoryEventStore(), { now: () => now }); });
afterEach(async () => { await server.close(); });
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: 'POST', body: JSON.stringify(body) });
const list = async (devices: string) => (await (await fetch(url(`/studio/open-requests?devices=${encodeURIComponent(devices)}`))).json()) as { requests: Array<Record<string, unknown>> };

describe('Studio 열기 요청', () => {
  it('남기면 그 기기의 목록에 보이고, ack 하면 사라진다; 다른 기기 목록에는 없다', async () => {
    const r = await post('/studio/open-requests', { deviceId: 'R3CN30ABCDXLZW', goal: '검색 결과를 연다', app: 'com.google.android.youtube', from: { cycleId: 'c1', testId: 'YouTube 검색', targetId: 'android' } });
    expect(r.status).toBe(201);
    const { id } = await r.json() as { id: string };
    expect((await list('OTHER1')).requests).toEqual([]);
    expect((await list('OTHER1,R3CN30ABCDXLZW')).requests).toEqual([{ id, deviceId: 'R3CN30ABCDXLZW', goal: '검색 결과를 연다', app: 'com.google.android.youtube', from: { cycleId: 'c1', testId: 'YouTube 검색', targetId: 'android' }, createdAt: '2026-11-14T10:00:00.000Z' }]);
    expect((await post(`/studio/open-requests/${id}/ack`, {})).status).toBe(204);
    expect((await list('R3CN30ABCDXLZW')).requests).toEqual([]);
    expect((await post('/studio/open-requests/nope/ack', {})).status).toBe(404);
  });

  it('10분이 지나면 사라지고, 잘못된 요청은 400', async () => {
    await post('/studio/open-requests', { deviceId: 'D1' });
    now += 10 * 60_000 + 1;
    expect((await list('D1')).requests).toEqual([]);
    for (const bad of [{}, { deviceId: '' }, { deviceId: 'D1', goal: 'x'.repeat(2001) }, { deviceId: 'D1', app: 'com app;rm' }, { deviceId: 'D1', extra: 1 }]) expect((await post('/studio/open-requests', bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await fetch(url('/studio/open-requests'))).status).toBe(400); // devices 필요
  });
});
