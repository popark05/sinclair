// @vitest-environment node
// Console 05·06 의 control-plane 표면: Cycle 모델 사용량(GET /cycles/:id/usage)과 테스트 안정성 이력(GET /tests/history).
import { describe, it, expect, afterEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type CycleUsage, type HistoryView } from '../src/index.ts';

let server: ControlPlaneServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const url = (p: string) => `http://127.0.0.1:${server!.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: 'POST', body: JSON.stringify(body) });
let n = 0;
const ev = (runId: string, e: Record<string, unknown>): RunEvent => ({ schema: 1, eventId: `e${++n}`, runId, at: new Date(Date.UTC(2026, 10, 9, 0, 0, n)).toISOString(), ...e }) as RunEvent;
/** 테스트 하나(시도 attempts 개, 마지막 결과 result)를 도는 run 의 이벤트. 스텝마다 usage 를 싣는다 */
function run(runId: string, cycleId: string, targetId: string, tests: Array<{ testId: string; results: string[]; usage?: { modelCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>): RunEvent[] {
  const out: RunEvent[] = [ev(runId, { type: 'run.started', cycleId, targetId })];
  for (const t of tests) t.results.forEach((result, i) => {
    const attemptId = `${runId}-${t.testId}-${i}`;
    out.push(ev(runId, { type: 'attempt.started', attemptId, testId: t.testId, attemptNo: i + 1 }));
    if (t.usage) { const { modelCalls, ...usage } = t.usage; out.push(ev(runId, { type: 'step.recorded', attemptId, stepIndex: 0, kind: 'act', instruction: 'act', modelCalls, durationMs: 1, usage })); }
    out.push(ev(runId, { type: 'attempt.finished', attemptId, result, artifacts: [] }));
  });
  out.push(ev(runId, { type: 'run.finished', state: 'finished' }));
  return out;
}

describe('GET /cycles/:id/usage', () => {
  it('녹화 캐시: act 스텝의 cache 결정을 센다(재생·이어받음·라이브), 재생률 = 재생/(셋의 합), 캐시 결정 없는 스텝은 세지 않음', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    await post('/cycles', { cycleId: 'rc', build: '1.0', targets: ['android'] });
    await post('/cycles/rc/runs', { targetId: 'android', runId: 'rr' });
    const a = 'rr-a';
    const step = (i: number, cache: string | undefined, modelCalls: number) => ev('rr', { type: 'step.recorded', attemptId: a, stepIndex: i, kind: 'act', instruction: 'act', modelCalls, durationMs: 1, ...(cache ? { cache } : {}) });
    await post('/ingest', [ev('rr', { type: 'run.started', cycleId: 'rc', targetId: 'android' }), ev('rr', { type: 'attempt.started', attemptId: a, testId: 'T', attemptNo: 1 }),
      step(0, 'replayed', 0), step(1, 'replayed', 0), step(2, 'handed-off', 2), step(3, 'live', 3), step(4, undefined, 1),
      ev('rr', { type: 'attempt.finished', attemptId: a, result: 'passed', artifacts: [] }), ev('rr', { type: 'run.finished', state: 'finished' })]);
    const u = (await (await fetch(url('/cycles/rc/usage'))).json()) as CycleUsage;
    expect(u.recording).toEqual({ replayed: 2, handedOff: 1, live: 1, replayRate: 0.5 });
  });

  it('모델 호출·토큰을 Cycle 합계·타깃별·테스트별로(대체된 Run 포함), 캐시 적중률 = 읽기/(입력+읽기+쓰기); 요약의 진행률은 대체된 Run 을 뺀다', async () => {
    let now = Date.parse('2026-11-09T00:00:00Z');
    server = await serveControlPlane(createMemoryEventStore(), { now: () => now, leaseTtlMs: 1000 });
    await post('/cycles', { cycleId: 'c1', build: '1.0', targets: ['android', 'ios'] });
    // r-dead: 클레임해 시도 하나(모델 1회)를 보고하고 죽는다 → lease 만료 + 유예 뒤 조회 때 버려져 retry:r-dead 로 대체
    await post('/cycles/c1/runs', { targetId: 'android', runId: 'r-dead' });
    expect((await post('/runs/claim', { targetId: 'android', agentId: 'n1' })).status).toBe(200);
    await post('/ingest', run('r-dead', 'c1', 'android', [{ testId: '로그인', results: ['failed'], usage: { modelCalls: 1, inputTokens: 100, outputTokens: 10 } }]).slice(0, -1));
    now += 5000;
    const swept = (await (await fetch(url('/cycles/c1'))).json()) as { runs: Array<{ runId: string; replacedBy?: string }> };
    expect(swept.runs.find((r) => r.runId === 'r-dead')!.replacedBy).toBe('retry:r-dead');
    await post('/cycles/c1/runs', { targetId: 'android', runId: 'ra' });
    await post('/cycles/c1/runs', { targetId: 'ios', runId: 'ri' });
    await post('/ingest', [
      ...run('ra', 'c1', 'android', [{ testId: '로그인', results: ['failed', 'passed'], usage: { modelCalls: 4, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 1000 } }, { testId: '검색', results: ['passed'] }]),
      ...run('ri', 'c1', 'ios', [{ testId: '로그인', results: ['passed'], usage: { modelCalls: 2, inputTokens: 500, outputTokens: 50 } }]),
    ]);
    const res = await fetch(url('/cycles/c1/usage'));
    expect(res.status).toBe(200);
    const u = (await res.json()) as CycleUsage;
    // 손 계산: r-dead (1, 100/10) + android 로그인 두 시도 × (4, 1000/100/3000/1000) + ios 로그인 (2, 500/50)
    expect(u.total).toEqual({ modelCalls: 11, inputTokens: 2600, outputTokens: 260, cacheReadTokens: 6000, cacheWriteTokens: 2000, cacheHitRate: 6000 / 10600 });
    expect(u.byTarget.android!).toMatchObject({ modelCalls: 9, inputTokens: 2100, cacheHitRate: 6000 / 10100 });
    expect(u.byTarget.ios!).toMatchObject({ modelCalls: 2, cacheHitRate: 0 });
    expect(u.byTest['로그인']!).toMatchObject({ modelCalls: 11 });
    expect(u.byTest['검색']!).toMatchObject({ modelCalls: 0, cacheHitRate: null }); // 분모 0 이면 null
    expect((await fetch(url('/cycles/none/usage'))).status).toBe(404);
    // 요약의 진행률: 대체된 r-dead 는 빼고 retry:r-dead(대기)·ra·ri 만
    const summary = (await (await fetch(url('/cycles/summary'))).json()) as Array<{ cycleId: string; runs: { total: number; finished: number } }>;
    expect(summary.find((c) => c.cycleId === 'c1')!.runs).toEqual({ total: 3, finished: 2 });
  });
});

describe('GET /cycles/:id/usage · 모델별', () => {
  it('스텝의 모델별 내역을 모델마다 합친다(내역 없는 스텝은 합계에만)', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    await post('/cycles', { cycleId: 'm1', build: '1', targets: ['android'] });
    await post('/cycles/m1/runs', { targetId: 'android', runId: 'rm' });
    const step = (i: number, usage: Record<string, unknown>) => ev('rm', { type: 'step.recorded', attemptId: 'am', stepIndex: i, kind: 'act', modelCalls: 1, durationMs: 1, usage });
    await post('/ingest', [
      ev('rm', { type: 'run.started', cycleId: 'm1', targetId: 'android' }), ev('rm', { type: 'attempt.started', attemptId: 'am', testId: 't', attemptNo: 1 }),
      step(0, { inputTokens: 1200, outputTokens: 70, byModel: { 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 3000 }, 'claude-haiku-5-5': { inputTokens: 200, outputTokens: 20 } } }),
      step(1, { inputTokens: 500, outputTokens: 30, byModel: { 'claude-sonnet-5-5': { inputTokens: 500, outputTokens: 30 } } }),
      step(2, { inputTokens: 9, outputTokens: 9 }),
      ev('rm', { type: 'attempt.finished', attemptId: 'am', result: 'passed', artifacts: [] }), ev('rm', { type: 'run.finished', state: 'finished' }),
    ]);
    const u = (await (await fetch(url('/cycles/m1/usage'))).json()) as CycleUsage;
    expect(u.byModel).toEqual({
      'claude-sonnet-5-5': { inputTokens: 1500, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 0, cacheHitRate: 3000 / 4500 },
      'claude-haiku-5-5': { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 },
    });
    expect(u.total.inputTokens).toBe(1709);
  });
});

describe('GET /tests/history', () => {
  it('최근 N Cycle 의 테스트별 셀(오래된 → 최신), 통계, flaky 비율 = 흔들림/(통과 계열+실패); testId 로 거르기', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    const results = [['passed'], ['failed', 'passed'], ['failed', 'failed']];
    for (const [i, r] of results.entries()) {
      await post('/cycles', { cycleId: `c${i}`, build: `1.${i}`, targets: ['android'] });
      await new Promise((res) => setTimeout(res, 5)); // createdAt 순서
      await post(`/cycles/c${i}/runs`, { targetId: 'android', runId: `r${i}` });
      await post('/ingest', run(`r${i}`, `c${i}`, 'android', [{ testId: '로그인', results: r }, { testId: '검색', results: ['passed'] }]));
    }
    const h = (await (await fetch(url('/tests/history'))).json()) as HistoryView;
    expect(h.cycles.map((c: { cycleId: string }) => c.cycleId)).toEqual(['c0', 'c1', 'c2']);
    const login = h.tests.find((t) => t.testId === '로그인')!;
    expect(login.cells.map((c: { cycleId: string; verdict: string }) => `${c.cycleId}:${c.verdict}`)).toEqual(['c0:passed', 'c1:passed-flaky', 'c2:failed']);
    expect(login.stats).toMatchObject({ passed: 1, 'passed-flaky': 1, failed: 1 });
    expect(login.flakyRate).toBeCloseTo(1 / 3);
    expect(h.tests.find((t) => t.testId === '검색')!.flakyRate).toBe(0);
    expect(h.tests[0]!.testId).toBe('로그인'); // flaky 비율 높은 순
    const one = (await (await fetch(url(`/tests/history?testId=${encodeURIComponent('검색')}&limit=2`))).json()) as HistoryView;
    expect(one.cycles.map((c: { cycleId: string }) => c.cycleId)).toEqual(['c1', 'c2']);
    expect(one.tests.map((t: { testId: string }) => t.testId)).toEqual(['검색']);
    expect((await fetch(url('/tests/history?limit=0'))).status).toBe(400);
  });
});
