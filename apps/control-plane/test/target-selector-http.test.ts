// @vitest-environment node
// 조건 타깃: POST /cycles 가 이름·조건 타깃을 받고, targetId 없는 클레임이 조건에 맞는 빈 기기에 Run 을 준다(오래 쉰 기기 먼저).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type CycleView } from '../src/index.ts';
import { base } from './fixtures.ts';

let server: ControlPlaneServer;
let now = Date.parse('2026-11-08T00:00:00.000Z');
beforeEach(async () => { now = Date.parse('2026-11-08T00:00:00.000Z'); server = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 60_000, now: () => now }); });
afterEach(async () => { await server.close(); });
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: 'POST', body: JSON.stringify(body) });
const put = (agentId: string, devices: unknown[]) => fetch(url(`/fleet/nodes/${agentId}`), { method: 'PUT', body: JSON.stringify({ devices }) });
type Claimed = { run: { runId: string; targetId: string; lease: { deviceId?: string } } };
const claim = async (body: unknown): Promise<Claimed | undefined> => { const r = await post('/runs/claim', body); return r.status === 200 ? ((await r.json()) as Claimed) : undefined; };
const dev = (id: string, osVersion: string, model = 'SM-N981N') => ({ id, platform: 'android', model, osVersion, connection: 'device', helper: 'ready', locked: false });
const finish = (runId: string, deviceId: string, s: number) => post('/ingest', [
  { ...base(`${runId}-0`, s, runId), type: 'run.started', cycleId: 'c', targetId: 'any', deviceId },
  { ...base(`${runId}-1`, s + 1, runId), type: 'run.finished', state: 'finished' },
] satisfies RunEvent[]);

describe('조건 타깃 (HTTP)', () => {
  it('POST /cycles 는 이름과 조건 타깃을 섞어 받고 Cycle 뷰에 조건이 보인다; 잘못된 조건은 400', async () => {
    const res = await post('/cycles', { cycleId: 'c', build: 'b', targets: ['legacy', { id: 'a13', platform: 'android', osVersion: { min: '13' } }] });
    expect(res.status).toBe(201);
    const v = (await (await fetch(url('/cycles/c'))).json()) as CycleView;
    expect(v.targets).toEqual(['legacy', 'a13']);
    expect(v.targetSelectors).toEqual({ a13: { id: 'a13', platform: 'android', osVersion: { min: '13' } } });
    const bad = await post('/cycles', { build: 'b', targets: [{ id: 'x', platform: 'android', osVersion: { min: 'thirteen' } }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ errors: [expect.stringMatching(/osVersion\.min/)] });
  });

  it('targetId 없는 클레임: 조건에 맞는 빈 기기에만 Run 을 주고(Android 13 이상 → 13 기기만), 맞는 기기가 없으면 대기', async () => {
    await post('/cycles', { cycleId: 'c', build: 'b', targets: [{ id: 'a13', platform: 'android', osVersion: { min: '13' } }] });
    await post('/cycles/c/runs', { targetId: 'a13', runId: 'r1' });
    await put('n', [dev('OLD-12', '12'), dev('NEW-13', '13')]);
    expect(await claim({ agentId: 'n', devices: ['OLD-12'] })).toBeUndefined(); // 12 만 내놓으면 대기
    expect(await claim({ agentId: 'n', devices: ['OLD-12', 'NEW-13'] })).toMatchObject({ run: { runId: 'r1', targetId: 'a13', lease: { deviceId: 'NEW-13' } } });
  });

  it('모델 지정 조건, 이름 타깃은 노드가 선언한 이름일 때만; Fleet 에 없는 기기는 조건 타깃을 받지 못한다', async () => {
    await post('/cycles', { cycleId: 'c', build: 'b', targets: ['legacy', { id: 'note20', platform: 'android', model: 'SM-N981N' }] });
    await post('/cycles/c/runs', { targetId: 'legacy', runId: 'rl' });
    await post('/cycles/c/runs', { targetId: 'note20', runId: 'rn' });
    await put('n', [dev('PIXEL', '14', 'Pixel 7'), dev('NOTE', '13')]);
    // 선언 없이: 이름 타깃(rl)은 건너뛰고 조건에 맞는 rn 을 NOTE 로
    expect(await claim({ agentId: 'n', devices: ['PIXEL', 'NOTE'] })).toMatchObject({ run: { runId: 'rn', lease: { deviceId: 'NOTE' } } });
    // 선언하면 이름 타깃도 받는다(남은 기기 PIXEL 로)
    expect(await claim({ agentId: 'n', devices: ['PIXEL'], targets: ['legacy'] })).toMatchObject({ run: { runId: 'rl', lease: { deviceId: 'PIXEL' } } });
    // Fleet 에 보고하지 않은 기기는 속성을 몰라 조건 타깃을 받지 못한다
    await post('/cycles/c/runs', { targetId: 'note20', runId: 'rn2' });
    expect(await claim({ agentId: 'other', devices: ['UNKNOWN'] })).toBeUndefined();
  });

  it('맞는 빈 기기가 여럿이면 가장 오래 쉰 기기 먼저(한 번도 안 쓴 기기가 가장 앞); 셀에 돈 기기가 보인다', async () => {
    await post('/cycles', { cycleId: 'c', build: 'b', targets: [{ id: 'any', platform: 'android' }] });
    for (const r of ['r1', 'r2', 'r3']) await post('/cycles/c/runs', { targetId: 'any', runId: r });
    await put('n', [dev('D1', '13'), dev('D2', '13')]);
    const a = await claim({ agentId: 'n', devices: ['D1', 'D2'] }); // 둘 다 처음: 후보 순서대로 D1
    expect(a!.run.lease.deviceId).toBe('D1');
    await finish('r1', 'D1', 0);
    now += 1_000;
    const b = await claim({ agentId: 'n', devices: ['D1', 'D2'] }); // D2 는 한 번도 안 씀 → D2
    expect(b!.run.lease.deviceId).toBe('D2');
    await finish('r2', 'D2', 2);
    now += 1_000;
    const c = await claim({ agentId: 'n', devices: ['D1', 'D2'] }); // D1 이 더 오래 쉼
    expect(c!.run.lease.deviceId).toBe('D1');
    await post('/ingest', [{ ...base('t-a', 5, 'r1'), type: 'attempt.started', attemptId: 'a1', testId: '로그인', attemptNo: 1 }, { ...base('t-b', 6, 'r1'), type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [] }] satisfies RunEvent[]);
    const v = (await (await fetch(url('/cycles/c'))).json()) as CycleView;
    expect(v.matrix['로그인']!.any).toMatchObject({ verdict: 'passed', deviceId: 'D1' });
  });

  it('targetId 를 주는 기존 클레임도 조건 타깃이면 기기가 맞아야 한다', async () => {
    await post('/cycles', { cycleId: 'c', build: 'b', targets: [{ id: 'a14', platform: 'android', osVersion: { min: '14' } }] });
    await post('/cycles/c/runs', { targetId: 'a14', runId: 'r1' });
    await put('n', [dev('D13', '13'), dev('D14', '14')]);
    expect(await claim({ agentId: 'n', targetId: 'a14', devices: ['D13'] })).toBeUndefined();
    expect(await claim({ agentId: 'n', targetId: 'a14', devices: ['D13', 'D14'] })).toMatchObject({ run: { lease: { deviceId: 'D14' } } });
  });
});
