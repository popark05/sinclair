// @vitest-environment node
// createHttpReporter: 이벤트를 배치로 POST /ingest 하고, 일시 오류는 같은 eventId 로 재시도하며, 거부는 경고로 남긴다.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { RunEvent } from '@sinclair/protocol';
import { createHttpReporter } from '../src/index.ts';

const at = (s: number) => `2026-11-07T00:00:${String(s % 60).padStart(2, '0')}.000Z`;
const ev = (i: number): RunEvent => ({ schema: 1, eventId: `e${i}`, runId: 'r1', at: at(i), type: 'step.recorded', attemptId: 'a1', stepIndex: i, kind: 'act', modelCalls: 0, durationMs: 1 });

/** 페이크 Ingest: 받은 배치를 기록하고, 응답을 스크립트로 제어한다 */
type Behavior = 'ok' | '500' | 'drop' | 'reject-first' | '400';
async function fakeIngest() {
  const batches: RunEvent[][] = [];
  const script: Behavior[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const batch = JSON.parse(Buffer.concat(chunks).toString()) as RunEvent[];
    const b = script.shift() ?? 'ok';
    if (b === 'drop') { req.socket.destroy(); return; }
    if (b === '500') { res.writeHead(500).end('{"error":"x"}'); return; }
    if (b === '400') { res.writeHead(400).end('{"error":"배열 아님"}'); return; }
    batches.push(batch);
    const rejected = b === 'reject-first' && batch.length ? [{ index: 0, eventId: batch[0]!.eventId, errors: ['kind: 상수 밖'] }] : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: batch.length - rejected.length, duplicate: 0, rejected }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/ingest`, port, batches, script, close: () => new Promise<void>((r) => server.close(() => r())), server };
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
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.batches).toHaveLength(1);
    await reporter.flush();
  });

  it('5xx 와 끊긴 연결은 같은 eventId 로 재시도하고, 성공하면 경고 없이 끝난다', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    srv.script.push('500', 'drop');
    const reporter = createHttpReporter({ url: srv.url, batchSize: 10, flushIntervalMs: 10_000, backoffMs: 5, maxBackoffMs: 20 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1));
    await reporter.flush();
    expect(srv.batches).toEqual([[ev(0), ev(1)]]); // 성공한 전송 1회, 그 전 두 번은 거부됨
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

  it('서버가 run 중간에 내려갔다 올라와도 flush 뒤 모든 이벤트가 순서대로 도착한다', async () => {
    const srv = await fakeIngest();
    const reporter = createHttpReporter({ url: srv.url, batchSize: 2, flushIntervalMs: 10, backoffMs: 5, maxBackoffMs: 30 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1));
    await new Promise((r) => setTimeout(r, 50));
    await srv.close(); // 내려감
    reporter.onEvent(ev(2)); reporter.onEvent(ev(3)); reporter.onEvent(ev(4));
    await new Promise((r) => setTimeout(r, 80)); // 연결 거부를 몇 번 겪는다
    const again = await fakeIngest(); cleanup.push(again.close);
    // 같은 포트로 다시 띄울 수 없으므로 URL 을 바꾼다
    reporter.setUrl(again.url);
    await reporter.flush();
    expect(srv.batches.flat().concat(again.batches.flat()).map((e) => e.eventId)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(reporter.warnings).toEqual([]);
  });

  it('배치가 이미 간 뒤 간격 타이머가 빈 큐로 돌아도 다음 flush 가 멈추지 않는다 (회귀)', async () => {
    const srv = await fakeIngest(); cleanup.push(srv.close);
    const reporter = createHttpReporter({ url: srv.url, batchSize: 2, flushIntervalMs: 10, backoffMs: 5 });
    reporter.onEvent(ev(0)); reporter.onEvent(ev(1)); // 배치가 차서 즉시 전송, 타이머는 10ms 뒤 빈 큐로 돈다
    await new Promise((r) => setTimeout(r, 50));
    reporter.onEvent(ev(2));
    await reporter.flush();
    expect(srv.batches.flat().map((e) => e.eventId)).toEqual(['e0', 'e1', 'e2']);
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
});
