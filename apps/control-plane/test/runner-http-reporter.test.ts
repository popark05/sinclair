// @vitest-environment node
// 종단: 러너(FakeEngine) → HTTP Reporter → 실제 Ingest → GET /runs/:id. 첫 응답을 끊는 프록시를 끼워 재전송(같은 eventId)이 투영을 바꾸지 않음을 본다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import * as path from 'node:path';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { runTests, createHttpReporter } from '@sinclair/runner';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type RunView } from '../src/index.ts';

let server: ControlPlaneServer;
beforeEach(async () => { server = await serveControlPlane(createMemoryEventStore()); });
afterEach(async () => { await server.close(); });

const fixture = path.resolve(import.meta.dirname, 'fixtures/mixed.sinclair.ts');
const engine = () => new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });

/** 요청을 Ingest 로 전달하되, 지정한 횟수만큼은 Ingest 가 저장한 뒤 응답을 돌려주지 않고 연결을 끊는다 */
async function dropAfterForwardProxy(target: number, dropCount: number) {
  let dropped = 0;
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const upstream = await fetch(`http://127.0.0.1:${target}${req.url}`, { method: req.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
    const body = await upstream.text();
    if (dropped < dropCount) { dropped++; req.socket.destroy(); return; }
    res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  return { port: (proxy.address() as { port: number }).port, dropped: () => dropped, close: () => new Promise<void>((r) => proxy.close(() => r())) };
}

describe('러너 → HTTP Reporter → Ingest', () => {
  it('run 이 끝나면 모든 이벤트가 저장돼 있고 투영이 RunReport 와 일치한다', async () => {
    const reporter = createHttpReporter({ url: `http://127.0.0.1:${server.port}/ingest`, batchSize: 3, flushIntervalMs: 20, backoffMs: 10 });
    const report = await runTests([fixture], { engine: engine(), timeoutMs: 200, reporter, cycleId: 'c1' });
    expect(report.warnings).toBeUndefined();
    expect(reporter.stats).toMatchObject({ sent: report.events.length, accepted: report.events.length, duplicate: 0, rejected: 0 });
    const view = (await (await fetch(`http://127.0.0.1:${server.port}/runs/${report.runId}`)).json()) as RunView;
    expect(view).toMatchObject({ state: 'finished', cycleId: 'c1' });
    expect(view.attempts.map((a) => [a.testId, a.result, a.steps.length])).toEqual(report.tests.map((t) => [t.name, t.result, t.steps.length]));
  });

  it('Ingest 가 저장한 뒤 응답이 끊겨 재전송돼도 투영은 한 번 보낸 것과 같다', async () => {
    const proxy = await dropAfterForwardProxy(server.port, 2);
    try {
      const reporter = createHttpReporter({ url: `http://127.0.0.1:${proxy.port}/ingest`, batchSize: 2, flushIntervalMs: 20, backoffMs: 10, maxBackoffMs: 20 });
      const report = await runTests([fixture], { engine: engine(), timeoutMs: 200, reporter });
      expect(proxy.dropped()).toBe(2);
      expect(reporter.stats.retries).toBeGreaterThanOrEqual(2);
      expect(reporter.stats.duplicate).toBeGreaterThanOrEqual(1); // 재전송된 배치는 Ingest 가 duplicate 로 받는다(같은 배치가 두 번 끊기면 성공 응답은 하나)
      const view = await (await fetch(`http://127.0.0.1:${server.port}/runs/${report.runId}`)).text();
      // 같은 이벤트를 한 번만 넣은 별도 Ingest 의 투영과 바이트 단위로 같아야 한다
      const once = await serveControlPlane(createMemoryEventStore());
      try {
        await fetch(`http://127.0.0.1:${once.port}/ingest`, { method: 'POST', body: JSON.stringify(report.events) });
        expect(view).toBe(await (await fetch(`http://127.0.0.1:${once.port}/runs/${report.runId}`)).text());
      } finally {
        await once.close();
      }
    } finally {
      await proxy.close();
    }
  });
});
