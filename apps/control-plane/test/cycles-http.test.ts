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
});
