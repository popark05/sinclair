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

  it('POST /cycles 는 suite 필터를 받아 저장하고 GET /cycles/:id 에 돌려준다; 잘못된 suite 는 400', async () => {
    expect((await post('/cycles', { cycleId: 'cs', build: 'b', targets: ['android'], suite: { tests: 'tests/smoke', tags: ['smoke'] } })).status).toBe(201);
    expect((await (await fetch(url('/cycles/cs'))).json() as CycleView).suite).toEqual({ tests: 'tests/smoke', tags: ['smoke'] });
    expect((await post('/cycles', { build: 'b', targets: ['android'], suite: { tags: ['x'] } })).status).toBe(400);
    expect((await post('/cycles', { build: 'b', targets: ['android'], suite: 'tests' })).status).toBe(400);
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
    await post('/ingest', [{ ...base('x0', 0, 'r-i'), type: 'run.started', cycleId: 'cl', targetId: 'ios' }] satisfies RunEvent[]);
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
