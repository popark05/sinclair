// @vitest-environment node
// Cycle API: 생성 → Run 등록 → 이벤트 Ingest → GET /cycles/:id 매트릭스·Verdict. 러너 FakeEngine 이벤트 + 손으로 만든 재시도 run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import type { RunEvent } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { runTests } from '@sinclair/runner';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type CycleView, type CycleRecord, type RunRegistration } from '../src/index.ts';
import { base } from './fixtures.ts';

let server: ControlPlaneServer;
beforeEach(async () => { server = await serveControlPlane(createMemoryEventStore()); });
afterEach(async () => { await server.close(); });
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('Cycle API', () => {
  it('POST /cycles 는 201 과 레코드를, 검증 실패는 400, 같은 cycleId 는 409', async () => {
    const res = await post('/cycles', { build: '1.2.3', targets: ['android', 'ios', 'android'], requiredTags: ['smoke'] });
    expect(res.status).toBe(201);
    const cycle = (await res.json()) as CycleRecord;
    expect(cycle).toMatchObject({ build: '1.2.3', targets: ['android', 'ios'], requiredTags: ['smoke'] });
    expect(cycle.cycleId).toMatch(/[0-9a-f-]{36}/);
    expect((await post('/cycles', { build: '', targets: ['a'] })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: [] })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: ['a'], requiredTags: 'smoke' })).status).toBe(400);
    expect((await post('/cycles', '{')).status).toBe(400);
    expect((await post('/cycles', { cycleId: 'fixed', build: 'b', targets: ['a'] })).status).toBe(201);
    expect((await post('/cycles', { cycleId: 'fixed', build: 'b', targets: ['a'] })).status).toBe(409);
    expect(((await (await fetch(url('/cycles'))).json()) as CycleRecord[]).map((c) => c.cycleId)).toEqual([cycle.cycleId, 'fixed']);
  });

  it('POST /cycles/:id/runs 는 타깃을 검사하고 runId 를 발급하며, 모르는 Cycle 은 404', async () => {
    await post('/cycles', { cycleId: 'c1', build: 'b', targets: ['android'] });
    const ok = await post('/cycles/c1/runs', { targetId: 'android' });
    expect(ok.status).toBe(201);
    expect((await ok.json()) as RunRegistration).toMatchObject({ cycleId: 'c1', targetId: 'android', runId: expect.stringMatching(/[0-9a-f-]{36}/) });
    expect((await post('/cycles/c1/runs', { targetId: 'ios' })).status).toBe(400);
    expect((await post('/cycles/c1/runs', { targetId: 'android', runId: 'r-fixed' })).status).toBe(201);
    expect((await post('/cycles/c1/runs', { targetId: 'android', runId: 'r-fixed' })).status).toBe(409);
    expect((await post('/cycles/없음/runs', { targetId: 'android' })).status).toBe(404);
    expect((await fetch(url('/cycles/없음'))).status).toBe(404);
    const view = (await (await fetch(url('/cycles/c1'))).json()) as CycleView;
    expect(view).toMatchObject({ state: 'running', verdict: 'incomplete', runs: [{ targetId: 'android', state: 'queued' }, { runId: 'r-fixed', state: 'queued' }] });
  });

  it('Cycle → Run 2개 → 러너 이벤트 + 재시도 run → 매트릭스에 passed-flaky, Verdict 는 규칙대로', async () => {
    await post('/cycles', { cycleId: 'c1', build: '1.2.3', targets: ['android', 'ios'] });
    const android = (await (await post('/cycles/c1/runs', { targetId: 'android' })).json()) as RunRegistration;
    const ios = (await (await post('/cycles/c1/runs', { targetId: 'ios' })).json()) as RunRegistration;

    // android: 러너(FakeEngine)가 실제로 낸 이벤트. 로그인 테스트 통과
    const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    const report = await runTests([path.resolve(import.meta.dirname, 'fixtures/login.sinclair.ts')], { engine, timeoutMs: 200, runId: android.runId, cycleId: 'c1', targetId: 'android' });
    expect(report.summary).toEqual({ passed: 1, failed: 0, blocked: 0, skipped: 0 });
    await post('/ingest', report.events);

    // 중간 조회: ios 가 아직이라 running/incomplete
    let view = (await (await fetch(url('/cycles/c1'))).json()) as CycleView;
    expect(view).toMatchObject({ state: 'running', verdict: 'incomplete' });
    expect(view.matrix['로그인 > 아이디로 로그인한다']).toEqual({ android: { verdict: 'passed', attemptId: expect.any(String) } });

    // ios: 재시도 run(러너는 아직 재시도를 내지 않으므로 손으로 만든다). 1회 실패 → 2회 통과
    const r = ios.runId;
    const b = (id: string, s: number) => base(id, s, r);
    const retry: RunEvent[] = [
      { ...b('i0', 0), type: 'run.started', cycleId: 'c1', targetId: 'ios' },
      { ...b('i1', 1), type: 'attempt.started', attemptId: 'ios-a1', testId: '로그인 > 아이디로 로그인한다', attemptNo: 1 },
      { ...b('i2', 2), type: 'attempt.finished', attemptId: 'ios-a1', result: 'failed', errorCode: 'not-found', artifacts: [] },
      { ...b('i3', 3), type: 'attempt.started', attemptId: 'ios-a2', testId: '로그인 > 아이디로 로그인한다', attemptNo: 2 },
      { ...b('i4', 4), type: 'attempt.finished', attemptId: 'ios-a2', result: 'passed', artifacts: [] },
      { ...b('i5', 5), type: 'run.finished', state: 'finished' },
    ];
    await post('/ingest', retry);

    view = (await (await fetch(url('/cycles/c1'))).json()) as CycleView;
    expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(view.matrix['로그인 > 아이디로 로그인한다']).toEqual({ android: { verdict: 'passed', attemptId: expect.any(String) }, ios: { verdict: 'passed-flaky', attemptId: 'ios-a2' } });
    expect(view.runs.map((x) => x.state)).toEqual(['finished', 'finished']);
  });

  it('끝난 Cycle 에는 Run 을 더 등록할 수 없고(409), 이벤트의 cycleId/targetId 가 등록과 다르면 warnings 로 드러난다', async () => {
    await post('/cycles', { cycleId: 'c2', build: 'b', targets: ['android'] });
    await post('/cycles/c2/runs', { targetId: 'android', runId: 'r-c2' });
    const b = (id: string, s: number) => base(id, s, 'r-c2');
    await post('/ingest', [
      { ...b('x0', 0), type: 'run.started', cycleId: '다른-cycle', targetId: 'ios' },
      { ...b('x1', 1), type: 'attempt.started', attemptId: 'x-a1', testId: 'T', attemptNo: 1 },
      { ...b('x2', 2), type: 'attempt.finished', attemptId: 'x-a1', result: 'passed', artifacts: [] },
      { ...b('x3', 3), type: 'run.finished', state: 'finished' },
    ] satisfies RunEvent[]);
    const view = (await (await fetch(url('/cycles/c2'))).json()) as CycleView & { warnings?: string[] };
    expect(view).toMatchObject({ state: 'finished', verdict: 'verified' }); // 판정은 등록(android)을 따른다
    expect(view.warnings).toEqual([expect.stringContaining('cycleId(다른-cycle)'), expect.stringContaining('targetId(ios)')]);
    const late = await post('/cycles/c2/runs', { targetId: 'android' });
    expect(late.status).toBe(409);
  });

  it('infra-failed 로 끝난 run 에서 돌지 못한 케이스는 HTTP 조회에서도 blocked 다', async () => {
    await post('/cycles', { cycleId: 'c3', build: 'b', targets: ['android', 'ios'] });
    await post('/cycles/c3/runs', { targetId: 'android', runId: 'r-and' });
    await post('/cycles/c3/runs', { targetId: 'ios', runId: 'r-ios' });
    const a = (id: string, s: number) => base(id, s, 'r-and');
    const i = (id: string, s: number) => base(id, s, 'r-ios');
    await post('/ingest', [
      { ...a('a0', 0), type: 'run.started', cycleId: 'c3', targetId: 'android' },
      { ...a('a1', 1), type: 'attempt.started', attemptId: 'a-1', testId: 'T', attemptNo: 1 },
      { ...a('a2', 2), type: 'attempt.finished', attemptId: 'a-1', result: 'passed', artifacts: [] },
      { ...a('a3', 3), type: 'run.finished', state: 'finished' },
      { ...i('i0', 0), type: 'run.started', cycleId: 'c3', targetId: 'ios' },
      { ...i('i1', 1), type: 'run.finished', state: 'infra-failed' },
    ] satisfies RunEvent[]);
    const view = (await (await fetch(url('/cycles/c3'))).json()) as CycleView;
    expect(view).toMatchObject({ state: 'finished', verdict: 'blocked' });
    expect(view.matrix.T).toEqual({ android: { verdict: 'passed', attemptId: 'a-1' }, ios: { verdict: 'blocked' } });
    expect((await fetch(url('/cycles/%E'))).status).toBe(400); // 잘못된 경로 인코딩
  });

  it('cancelled 로 끝난 run 의 돌지 않은 케이스는 blocked 이고 Cycle 은 finished/blocked 다(verified 아님)', async () => {
    await post('/cycles', { cycleId: 'cx', build: 'b', targets: ['android', 'ios'] });
    await post('/cycles/cx/runs', { targetId: 'android', runId: 'ra' });
    await post('/cycles/cx/runs', { targetId: 'ios', runId: 'ri' });
    const T = '로그인';
    const full = (run: string, target: string, p: string): RunEvent[] => [
      { ...base(`${p}0`, 0, run), type: 'run.started', cycleId: 'cx', targetId: target },
      { ...base(`${p}1`, 1, run), type: 'attempt.started', attemptId: `${p}a1`, testId: T, attemptNo: 1 },
      { ...base(`${p}2`, 2, run), type: 'attempt.finished', attemptId: `${p}a1`, result: 'passed', artifacts: [] },
      { ...base(`${p}3`, 3, run), type: 'attempt.started', attemptId: `${p}a2`, testId: '결제', attemptNo: 1 },
      { ...base(`${p}4`, 4, run), type: 'attempt.finished', attemptId: `${p}a2`, result: 'passed', artifacts: [] },
      { ...base(`${p}5`, 5, run), type: 'run.finished', state: 'finished' },
    ];
    // ios 는 첫 케이스만 통과하고 취소됨(두 번째는 러너가 skipped 로 기록)
    const cancelled: RunEvent[] = [
      { ...base('i0', 0, 'ri'), type: 'run.started', cycleId: 'cx', targetId: 'ios' },
      { ...base('i1', 1, 'ri'), type: 'attempt.started', attemptId: 'ia1', testId: T, attemptNo: 1 },
      { ...base('i2', 2, 'ri'), type: 'attempt.finished', attemptId: 'ia1', result: 'passed', artifacts: [] },
      { ...base('i3', 3, 'ri'), type: 'attempt.started', attemptId: 'ia2', testId: '결제', attemptNo: 1 },
      { ...base('i4', 4, 'ri'), type: 'attempt.finished', attemptId: 'ia2', result: 'skipped', artifacts: [] },
      { ...base('i5', 5, 'ri'), type: 'run.finished', state: 'cancelled' },
    ];
    await post('/ingest', [...full('ra', 'android', 'a'), ...cancelled]);
    const v = (await (await fetch(url('/cycles/cx'))).json()) as CycleView;
    expect(v).toMatchObject({ state: 'finished', verdict: 'blocked' });
    expect(v.runs.map((r) => r.state)).toEqual(['finished', 'cancelled']);
    expect(v.matrix['결제']!.ios).toMatchObject({ verdict: 'blocked' }); // 취소로 돌지 못한 케이스는 skipped 가 아니라 blocked
    expect(v.matrix[T]!.ios).toMatchObject({ verdict: 'passed' });
  });

  it('POST /cycles 는 suite 필터를 받아 저장하고 GET /cycles/:id 에 돌려준다; 잘못된 suite 는 400', async () => {
    expect((await post('/cycles', { cycleId: 'cs', build: 'b', targets: ['android'], suite: { tests: 'tests/smoke', tags: ['smoke'] } })).status).toBe(201);
    expect((await (await fetch(url('/cycles/cs'))).json() as CycleView).suite).toEqual({ tests: 'tests/smoke', tags: ['smoke'] });
    expect((await post('/cycles', { build: 'b', targets: ['android'], suite: { tags: ['x'] } })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: ['android'], suite: 'tests' })).status).toBe(400);
    // suite.retries: 0~5 정수, 저장되고 클레임 응답의 suite 에 실린다
    expect((await post('/cycles', { cycleId: 'cr', build: 'b', targets: ['android'], suite: { tests: 'tests/smoke', retries: 2 } })).status).toBe(201);
    expect((await (await fetch(url('/cycles/cr'))).json() as CycleView).suite).toEqual({ tests: 'tests/smoke', retries: 2 });
    await post('/cycles/cr/runs', { targetId: 'android' });
    expect(await (await post('/runs/claim', { targetId: 'android', agentId: 'a' })).json()).toMatchObject({ suite: { tests: 'tests/smoke', retries: 2 } });
    expect((await post('/cycles', { build: 'b', targets: ['android'], suite: { tests: 't', retries: 6 } })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: ['android'], suite: { tests: 't', retries: '1' } })).status).toBe(400);
  });

  it('POST /runs/claim 은 대기 중인 Run 을 lease 와 suite 와 함께 주고(200), 없으면 204; heartbeat 는 소유자만(409), 모르는 Run 은 404; lease 가 Cycle 뷰에 보인다', async () => {
    await post('/cycles', { cycleId: 'cl', build: 'b', targets: ['android', 'ios'], suite: { tests: 'tests/all' } });
    await post('/cycles/cl/runs', { targetId: 'android', runId: 'r-a' });
    await post('/cycles/cl/runs', { targetId: 'ios', runId: 'r-i' });
    const claimed = await post('/runs/claim', { targetId: 'android', agentId: 'node-1' });
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as { run: { runId: string; lease: { agentId: string; expiresAt: string } }; leaseTtlMs: number; suite?: { tests: string } };
    expect(body).toMatchObject({ run: { runId: 'r-a', lease: { agentId: 'node-1' } }, leaseTtlMs: 60_000, suite: { tests: 'tests/all' } });
    expect((await post('/runs/claim', { targetId: 'android', agentId: 'node-2' })).status).toBe(204); // 남은 android 없음
    expect((await post('/runs/claim', { targetId: 'android' })).status).toBe(400);

    const view = (await (await fetch(url('/cycles/cl'))).json()) as CycleView;
    expect(view.runs).toEqual([{ runId: 'r-a', targetId: 'android', state: 'queued', lease: { agentId: 'node-1', expiresAt: body.run.lease.expiresAt } }, { runId: 'r-i', targetId: 'ios', state: 'queued' }]);

    const hb = await post('/runs/r-a/heartbeat', { agentId: 'node-1' });
    expect(hb.status).toBe(200);
    expect(((await hb.json()) as { expiresAt: string }).expiresAt >= body.run.lease.expiresAt).toBe(true);
    expect((await post('/runs/r-a/heartbeat', { agentId: 'node-9' })).status).toBe(409);
    expect((await post('/runs/없음/heartbeat', { agentId: 'node-1' })).status).toBe(404);

    // 이벤트가 들어온 Run 은 lease 가 만료돼도 다시 클레임되지 않는다
    // 이벤트 시각은 지금: 오래전 이벤트면 버려진 Run 으로 정리돼 대체 Run 이 클레임된다(sweep 테스트가 다룬다)
    await post('/ingest', [{ ...base('x0', 0, 'r-i'), at: new Date().toISOString(), type: 'run.started', cycleId: 'cl', targetId: 'ios' }] satisfies RunEvent[]);
    expect((await post('/runs/claim', { targetId: 'ios', agentId: 'node-2' })).status).toBe(204);
  });

  it('lease 가 만료되면 다른 에이전트가 같은 Run 을 가져간다 (짧은 TTL 서버)', async () => {
    await server.close();
    let now = Date.parse('2026-11-08T00:00:00.000Z');
    server = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 1000, now: () => now });
    await post('/cycles', { cycleId: 'ce', build: 'b', targets: ['android'] });
    await post('/cycles/ce/runs', { targetId: 'android', runId: 'r-e' });
    expect(((await (await post('/runs/claim', { targetId: 'android', agentId: 'a1' })).json()) as { run: { runId: string } }).run.runId).toBe('r-e');
    now += 999;
    expect((await post('/runs/claim', { targetId: 'android', agentId: 'a2' })).status).toBe(204);
    now += 1;
    expect(((await (await post('/runs/claim', { targetId: 'android', agentId: 'a2' })).json()) as { run: { lease: { agentId: string } } }).run.lease.agentId).toBe('a2');
  });
});

// 버려진 Run → 합성 infra-failed → 대체 Run → 클레임·완료 → verified. 시계와 유예는 서버 옵션으로 주입한다.
describe('버려진 Run 과 대체 Run (HTTP)', () => {
  const TTL = 1000;
  let now: number;
  const get = async (p: string) => (await fetch(url(p))).json() as Promise<CycleView>;
  const claim = async (targetId: string) => { const r = await post('/runs/claim', { targetId, agentId: 'a1' }); return r.status === 200 ? ((await r.json()) as { run: RunRegistration }).run : undefined; };
  const started = (runId: string, cycleId: string, s: number): RunEvent[] => [
    { ...base(`${runId}-0`, s, runId), at: new Date(now + s).toISOString(), type: 'run.started', cycleId, targetId: 'android' },
    { ...base(`${runId}-1`, s, runId), at: new Date(now + s + 1).toISOString(), type: 'attempt.started', attemptId: `${runId}-a1`, testId: '로그인', attemptNo: 1 },
  ];
  const finishedOk = (runId: string, cycleId: string): RunEvent[] => [
    ...started(runId, cycleId, 0),
    { ...base(`${runId}-2`, 0, runId), at: new Date(now + 2).toISOString(), type: 'attempt.finished', attemptId: `${runId}-a1`, result: 'passed', artifacts: [] },
    { ...base(`${runId}-3`, 0, runId), at: new Date(now + 3).toISOString(), type: 'run.finished', state: 'finished' },
  ];
  beforeEach(async () => {
    await server.close();
    now = Date.parse('2026-11-08T00:00:00.000Z');
    server = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: TTL, now: () => now });
  });

  it('유예 전에는 그대로, 유예 뒤 조회에서 infra-failed + 대체 Run; 대체 Run 을 클레임해 끝내면 Cycle verified', async () => {
    expect((await post('/cycles', { cycleId: 'c', build: 'b', targets: ['android'], retryLimit: 1 })).status).toBe(201);
    await post('/cycles/c/runs', { targetId: 'android', runId: 'r1' });
    expect((await claim('android'))?.runId).toBe('r1');
    await post('/ingest', started('r1', 'c', 0));
    now += TTL + TTL - 1; // lease 만료 + 유예 직전
    let view = await get('/cycles/c');
    expect(view).toMatchObject({ state: 'running', verdict: 'incomplete', retryLimit: 1, retriesUsed: { android: 0 } });
    expect(view.runs).toHaveLength(1);
    now += 1;
    view = await get('/cycles/c');
    expect(view.runs).toHaveLength(2);
    const [r1, rep] = view.runs;
    expect(r1).toMatchObject({ runId: 'r1', state: 'infra-failed', replacedBy: rep!.runId, abandonedAt: new Date(now).toISOString() });
    expect(rep).toMatchObject({ targetId: 'android', state: 'queued', replaces: 'r1' });
    expect(view).toMatchObject({ state: 'running', verdict: 'incomplete', retriesUsed: { android: 1 } });
    expect(view.matrix['로그인']).toBeUndefined(); // 대체된 run 의 케이스는 판정에서 빠진다(blocked 가 아님)
    // 원래 에이전트의 heartbeat 는 이제 409 replaced: 이걸 받아야 취소한다
    const hb = await post('/runs/r1/heartbeat', { agentId: 'a1' });
    expect(hb.status).toBe(409);
    expect(await hb.json()).toMatchObject({ code: 'replaced', replacedBy: rep!.runId });
    const claimed = await claim('android');
    expect(claimed?.runId).toBe(rep!.runId);
    await post('/ingest', finishedOk(rep!.runId, 'c'));
    view = await get('/cycles/c');
    expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(view.matrix['로그인']!.android).toMatchObject({ verdict: 'passed' });
  });

  it('retryLimit 0 이면 대체 없이 infra-failed 로 남아 Cycle 은 blocked; 클레임 경로도 같은 정리를 한다', async () => {
    await post('/cycles', { cycleId: 'c0', build: 'b', targets: ['android'], retryLimit: 0 });
    await post('/cycles/c0/runs', { targetId: 'android', runId: 'r1' });
    await claim('android');
    await post('/ingest', started('r1', 'c0', 0));
    now += 2 * TTL;
    expect(await claim('android')).toBeUndefined(); // 클레임에서 정리됐지만 한도 0 이라 대체 Run 없음
    const view = await get('/cycles/c0');
    expect(view).toMatchObject({ state: 'finished', verdict: 'blocked', retryLimit: 0, retriesUsed: { android: 0 } });
    expect(view.runs).toEqual([expect.objectContaining({ runId: 'r1', state: 'infra-failed' })]);
    expect(view.runs[0]!.replacedBy).toBeUndefined();
    expect(view.matrix['로그인']!.android).toEqual({ verdict: 'blocked' });
  });

  it('retryLimit 검증: 정수 0~5 밖은 400; 생략하면 1', async () => {
    expect((await post('/cycles', { build: 'b', targets: ['android'], retryLimit: 6 })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: ['android'], retryLimit: 1.5 })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: ['android'], retryLimit: '1' })).status).toBe(400);
    const created = (await (await post('/cycles', { cycleId: 'cd', build: 'b', targets: ['android'] })).json()) as CycleRecord;
    expect(created.retryLimit).toBeUndefined();
    expect((await get('/cycles/cd')).retryLimit).toBe(1);
  });
});
