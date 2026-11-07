// @vitest-environment node
// createHttpReporter: 이벤트를 배치로 POST /ingest 하고, 일시 오류는 같은 eventId 로 재시도하며, 거부는 경고로 남긴다.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { RunEvent } from '@sinclair/protocol';
import { createHttpReporter } from '../src/index.ts';

const at = (s: number) => `2026-11-07T00:00:${String(s % 60).padStart(2, '0')}.000Z`;
const ev = (i: number): RunEvent => ({ schema: 1, eventId: `e${i}`, runId: 'r1', at: at(i), type: 'step.recorded', attemptId: 'a1', stepIndex: i, kind: 'act', modelCalls: 0, durationMs: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 조건이 참이 될 때까지 폴링(전체 스위트 병렬 실행 중 고정 대기는 흔들린다). 상한 2초 */
async function until(cond: () => boolean, limitMs = 2000): Promise<void> { const t = Date.now(); while (!cond() && Date.now() - t < limitMs) await sleep(10); }

/** 페이크 Ingest: 받은 배치를 기록하고, 응답을 스크립트로 제어한다. port 를 주면 그 포트로 다시 띄운다(서버 재기동 시뮬레이션) */
type Behavior = 'ok' | '500' | '429' | 'drop' | 'reject-first' | '400' | '413';
async function fakeIngest(port = 0) {
  const batches: RunEvent[][] = [];
  const script: Behavior[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const batch = JSON.parse(Buffer.concat(chunks).toString()) as RunEvent[];
    const behavior = script.shift() ?? 'ok';
    if (behavior === 'drop') { req.socket.destroy(); return; }
    if (behavior === '500' || behavior === '429' || behavior === '400' || behavior === '413') { res.writeHead(Number(behavior)).end('{"error":"x"}'); return; }
    batches.push(batch);
    const rejected = behavior === 'reject-first' && batch.length ? [{ index: 0, eventId: batch[0]!.eventId, errors: ['kind: 상수 밖'] }] : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: batch.length - rejected.length, duplicate: 0, rejected }));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const bound = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${bound}/ingest`, port: bound, batches, script, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

describe('createHttpReporter', () => {
  it('이벤트를 batchSize 단위로 순서대로 보내고 flush 가 나머지를 보낸다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    const reporter = createHttpReporter({ url: srv.url, batchSize: 3, flushIntervalMs: 10_000, backoffMs: 10 });
    for (let i = 0; i < 7; i++) reporter.onEvent(ev(i));
    await reporter.flush();
    expect(srv.batches.map((b) => b.map((e) => e.eventId))).toEqual([['e0', 'e1', 'e2'], ['e3', 'e4', 'e5'], ['e6']]);
    expect(reporter.warnings).toEqual([]);
  });

  it('flushIntervalMs 가 지나면 배치가 차지 않아도 보낸다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    const reporter = createHttpReporter({ url: srv.url, batchSize: 100, flushIntervalMs: 20, backoffMs: 10 });
    reporter.onEvent(ev(0));
    await until(() => srv.batches.length === 1); // 간격(20ms) 뒤 전송
    expect(srv.batches).toHaveLength(1);
    await reporter.flush();
  });

  it('5xx·429·끊긴 연결은 같은 eventId 로 재시도하고, 성공하면 경고 없이 끝난다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    srv.script.push('500', '429', 'drop');
    const reporter = createHttpReporter({ url: srv.url, batchSize: 10, flushIntervalMs: 10_000, backoffMs: 5, maxBackoffMs: 20 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1));
    await reporter.flush();
    expect(srv.batches).toEqual([[ev(0), ev(1)]]); // 성공한 전송 1회, 그 전 세 번은 거부됨
    expect(reporter.stats.retries).toBe(3);
    expect(reporter.warnings).toEqual([]);
  });

  it('원소 거부(rejected[])와 400 은 재시도하지 않고 경고로 남긴다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    srv.script.push('reject-first', '400');
    const reporter = createHttpReporter({ url: srv.url, batchSize: 1, flushIntervalMs: 10_000, backoffMs: 5 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1));
    await reporter.flush();
    expect(srv.batches).toHaveLength(1); // 400 받은 배치는 기록되지 않았고 재시도도 없음
    expect(reporter.warnings).toEqual([expect.stringMatching(/e0.*kind: 상수 밖/), expect.stringMatching(/400/)]);
  });

  it('413 은 배치를 반으로 쪼개 다시 보내고, 1건도 넘으면 버리고 경고한다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    srv.script.push('413', 'ok', '413', '413'); // [e0..e3] → 413, [e0,e1] ok, [e2,e3] → 413, [e2] → 413(버림), [e3] ok
    const reporter = createHttpReporter({ url: srv.url, batchSize: 4, flushIntervalMs: 10_000, backoffMs: 5 });
    for (let i = 0; i < 4; i++) reporter.onEvent(ev(i));
    await reporter.flush();
    expect(srv.batches.map((b) => b.map((e) => e.eventId))).toEqual([['e0', 'e1'], ['e3']]);
    expect(reporter.warnings).toEqual([expect.stringMatching(/e2.*본문 상한/)]);
  });

  it('서버가 run 중간에 내려갔다 같은 포트로 올라와도 flush 뒤 모든 이벤트가 순서대로 도착한다', async () => {
    const srv = await fakeIngest();
    const reporter = createHttpReporter({ url: srv.url, batchSize: 2, flushIntervalMs: 10, backoffMs: 5, maxBackoffMs: 30 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1));
    await until(() => srv.batches.length === 1); // 첫 배치 도착
    await srv.close(); // 내려감
    reporter.onEvent(ev(2)); reporter.onEvent(ev(3)); reporter.onEvent(ev(4));
    await until(() => reporter.stats.retries > 0); // 연결 거부를 최소 한 번 겪는다
    expect(reporter.stats.retries).toBeGreaterThan(0);
    const again = await fakeIngest(srv.port); cleanup.push(again.close); // 같은 포트로 재기동
    await reporter.flush();
    expect(srv.batches.flat().concat(again.batches.flat()).map((e) => e.eventId)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(reporter.warnings).toEqual([]);
  });

  it('배치가 이미 간 뒤 간격 타이머가 빈 큐로 돌아도 다음 flush 가 멈추지 않는다 (회귀, fetch 완료 시점을 주입으로 고정)', async () => {
    const sent: string[][] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as RunEvent[];
      sent.push(batch.map((e) => e.eventId));
      return new Response(JSON.stringify({ accepted: batch.length, duplicate: 0, rejected: [] }), { status: 200 });
    };
    const reporter = createHttpReporter({ url: 'http://127.0.0.1:1/ingest', fetch: fakeFetch, batchSize: 2, flushIntervalMs: 1, backoffMs: 5 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1)); // 배치가 차서 즉시 전송(동기 fetch 라 바로 끝남), 타이머는 1ms 뒤 빈 큐로 돈다
    await sleep(20);
    reporter.onEvent(ev(2));
    await reporter.flush();
    expect(sent).toEqual([['e0', 'e1'], ['e2']]);
  });

  it('flush 중 새 이벤트가 들어와도 flush 는 그 시점까지의 이벤트를 모두 보낸 뒤 끝난다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    const reporter = createHttpReporter({ url: srv.url, batchSize: 10, flushIntervalMs: 10_000, backoffMs: 5 });
    reporter.onEvent(ev(0));
    const p = reporter.flush();
    reporter.onEvent(ev(1));
    await p;
    await reporter.flush();
    expect(srv.batches.flat().map((e) => e.eventId)).toEqual(['e0', 'e1']);
  });

  it('close 는 영구 다운된 서버에 대한 재시도를 멈추고 남은 이벤트 수를 경고로 남긴다', async () => {
    const srv = await fakeIngest(); await srv.close(); // 닫힌 포트
    const reporter = createHttpReporter({ url: srv.url, batchSize: 2, flushIntervalMs: 10, backoffMs: 50, maxBackoffMs: 60_000 });
    for (let i = 0; i < 5; i++) reporter.onEvent(ev(i));
    await sleep(30);
    const started = Date.now();
    await reporter.close(); // 백오프 대기(50ms→…) 중이어도 바로 깬다
    expect(Date.now() - started).toBeLessThan(200);
    expect(reporter.warnings).toEqual([expect.stringMatching(/3건을 보내지 못함/)]); // 첫 배치 2건은 전송 중, 나머지 3건은 큐
    reporter.onEvent(ev(9)); // 이후 이벤트는 무시
    await reporter.flush();
    expect(reporter.stats.sent).toBe(0);
  });

  it('잘못된 URL 은 재시도 대상이 아니라 생성 시 오류다', () => {
    expect(() => createHttpReporter({ url: 'not a url' })).toThrow();
  });
});
