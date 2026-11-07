// HTTP 표면. 127.0.0.1 에만 바인딩한다. 인증은 아직 없다(티켓 범위 밖).
//   POST /ingest        RunEvent[] 배치 → IngestResponse
//   GET  /runs          run 요약 목록
//   GET  /runs/:id      RunView (projection.ts)
//   GET  /health        200
import http from 'node:http';
import { ingestBatch } from './ingest.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';

export interface ControlPlaneOptions { port?: number; host?: string; maxBodyBytes?: number }

/** /ingest 본문 상한. 인증이 없으므로 같은 호스트의 다른 프로세스가 메모리를 채우지 못하게 막는다.
 *  Reporter 배치(03)는 수백 이벤트 × 수 KB 라 1 MB 안에 든다 */
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
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
        const limit = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > limit) {
            // 나머지 본문은 버리고 응답 뒤 연결을 닫는다(destroy 하면 클라이언트가 응답을 못 받는다)
            req.resume();
            res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: `본문이 ${limit} 바이트를 넘음` }));
            return;
          }
          chunks.push(c as Buffer);
        }
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
      // 내부 오류 내용은 로그에만 남긴다
      console.error('[control-plane]', err);
      return json(res, 500, { error: '내부 오류' });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => new Promise<void>((r) => server.close(() => r())) };
}
