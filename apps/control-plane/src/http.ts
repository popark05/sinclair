// HTTP 표면. 127.0.0.1 에만 바인딩한다. 인증은 아직 없다(티켓 범위 밖).
//   POST /ingest        RunEvent[] 배치 → IngestResponse
//   GET  /runs          run 요약 목록
//   GET  /runs/:id      RunView (projection.ts)
//   GET  /health        200
import http from 'node:http';
import { ingestBatch } from './ingest.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';

export interface ControlPlaneOptions { port?: number; host?: string }
export interface ControlPlaneServer { port: number; close(): Promise<void> }

export interface RunSummary { runId: string; state: RunView['state']; targetId?: string; startedAt?: string; finishedAt?: string; attempts: number }

export function summarizeRun(view: RunView): RunSummary {
  return {
    runId: view.runId, state: view.state, ...(view.targetId ? { targetId: view.targetId } : {}),
    ...(view.startedAt ? { startedAt: view.startedAt } : {}), ...(view.finishedAt ? { finishedAt: view.finishedAt } : {}), attempts: view.attempts.length,
  };
}

export async function serveControlPlane(store: EventStore, opts: ControlPlaneOptions = {}): Promise<ControlPlaneServer> {
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'JSON 파싱 실패' }); }
        if (!Array.isArray(body)) return json(res, 400, { error: '본문은 RunEvent 배열이어야 함' });
        return json(res, 200, await ingestBatch(store, body));
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && parts[0] === 'runs' && parts.length === 1) {
        const ids = await store.runIds();
        return json(res, 200, await Promise.all(ids.map(async (id) => summarizeRun(projectRun(await store.eventsForRun(id))))));
      }
      if (req.method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
        const events = await store.eventsForRun(decodeURIComponent(parts[1]!));
        if (events.length === 0) return json(res, 404, { error: '모르는 run' });
        return json(res, 200, projectRun(events));
      }
      return json(res, 404, { error: '모르는 경로' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => new Promise<void>((r) => server.close(() => r())) };
}
