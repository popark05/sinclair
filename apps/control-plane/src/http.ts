// HTTP 표면. 127.0.0.1 에만 바인딩한다. 인증은 아직 없다(티켓 범위 밖).
//   POST /ingest             RunEvent[] 배치 → IngestResponse
//   GET  /runs               run 요약 목록
//   GET  /runs/:id           RunView (projection.ts)
//   POST /cycles             { cycleId?, build, targets[], requiredTags? } → CycleRecord (201)
//   GET  /cycles             CycleRecord 목록
//   GET  /cycles/:id         CycleView (verdict.ts: 상태·Verdict·매트릭스)
//   POST /cycles/:id/runs    { targetId, runId? } → RunRegistration (201)
//   GET  /health             200
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ingestBatch } from './ingest.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';
import { createMemoryCycleStore, type CycleStore } from './cycle-store.ts';
import { buildCycleView } from './cycle-view.ts';

export interface ControlPlaneOptions {
  port?: number;
  host?: string;
  maxBodyBytes?: number;
  /** Cycle/Run 등록 저장소. 없으면 인메모리 */
  cycles?: CycleStore;
}

/** /ingest 본문 상한. 인증이 없으므로 같은 호스트의 다른 프로세스가 메모리를 채우지 못하게 막는다.
 *  Reporter 배치(03)는 수백 이벤트 × 수 KB 라 1 MB 안에 든다 */
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export interface ControlPlaneServer { port: number; close(): Promise<void> }

export interface RunSummary { runId: string; state: RunView['state']; cycleId?: string; targetId?: string; startedAt?: string; finishedAt?: string; attempts: number }

export function summarizeRun(view: RunView): RunSummary {
  return {
    runId: view.runId, state: view.state, ...(view.cycleId ? { cycleId: view.cycleId } : {}), ...(view.targetId ? { targetId: view.targetId } : {}),
    ...(view.startedAt ? { startedAt: view.startedAt } : {}), ...(view.finishedAt ? { finishedAt: view.finishedAt } : {}), attempts: view.attempts.length,
  };
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 생략 가능하되, 있으면 비어 있지 않은 문자열 */
const optionalId = (v: unknown): v is string | undefined => v === undefined || (typeof v === 'string' && v.length > 0);
const TERMINAL_CYCLE = new Set(['finished', 'expired', 'cancelled']);

export async function serveControlPlane(store: EventStore, opts: ControlPlaneOptions = {}): Promise<ControlPlaneServer> {
  const cycles = opts.cycles ?? createMemoryCycleStore();
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  /** 본문을 JSON 으로 읽는다. 상한을 넘으면 413 을 보내고 undefined, 파싱 실패면 400 을 보내고 undefined */
  const readJson = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<{ body: unknown } | undefined> => {
    const limit = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) {
        // 나머지 본문은 버리고 응답 뒤 연결을 닫는다(destroy 하면 클라이언트가 응답을 못 받는다)
        req.resume();
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: `본문이 ${limit} 바이트를 넘음` }));
        return undefined;
      }
      chunks.push(c as Buffer);
    }
    try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { json(res, 400, { error: 'JSON 파싱 실패' }); return undefined; }
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let parts: string[];
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return json(res, 400, { error: '경로 인코딩이 잘못됨' }); }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const read = await readJson(req, res);
        if (!read) return;
        if (!Array.isArray(read.body)) return json(res, 400, { error: '본문은 RunEvent 배열이어야 함' });
        return json(res, 200, await ingestBatch(store, read.body));
      }
      if (req.method === 'POST' && url.pathname === '/cycles') {
        const read = await readJson(req, res);
        if (!read) return;
        const b = read.body;
        if (!isRecord(b) || typeof b.build !== 'string' || !b.build || !isStringArray(b.targets) || b.targets.length === 0) return json(res, 400, { error: 'build(문자열)와 targets(비어 있지 않은 문자열 배열)가 필요함' });
        if (b.requiredTags !== undefined && !isStringArray(b.requiredTags)) return json(res, 400, { error: 'requiredTags 는 문자열 배열이어야 함' });
        if (!optionalId(b.cycleId)) return json(res, 400, { error: 'cycleId 는 비어 있지 않은 문자열이어야 함' });
        const cycle = { cycleId: b.cycleId ?? randomUUID(), build: b.build, targets: [...new Set(b.targets)], requiredTags: (b.requiredTags as string[] | undefined) ?? [], createdAt: new Date().toISOString() };
        if ((await cycles.createCycle(cycle)) === 'duplicate') return json(res, 409, { error: `Cycle ${cycle.cycleId} 가 이미 있음` });
        return json(res, 201, cycle);
      }
      if (req.method === 'GET' && url.pathname === '/cycles') return json(res, 200, await cycles.listCycles());
      if (req.method === 'GET' && parts[0] === 'cycles' && parts.length === 2) {
        const view = await buildCycleView(store, cycles, parts[1]!);
        return view ? json(res, 200, view) : json(res, 404, { error: '모르는 Cycle' });
      }
      if (req.method === 'POST' && parts[0] === 'cycles' && parts.length === 3 && parts[2] === 'runs') {
        const cycle = await cycles.getCycle(parts[1]!);
        if (!cycle) return json(res, 404, { error: '모르는 Cycle' });
        const read = await readJson(req, res);
        if (!read) return;
        const b = read.body;
        if (!isRecord(b) || typeof b.targetId !== 'string' || !cycle.targets.includes(b.targetId)) return json(res, 400, { error: `targetId 는 Cycle 의 targets(${cycle.targets.join(', ')}) 중 하나여야 함` });
        if (!optionalId(b.runId)) return json(res, 400, { error: 'runId 는 비어 있지 않은 문자열이어야 함' });
        // 끝난 Cycle 의 Verdict 는 바뀌지 않아야 하므로 Run 을 더 받지 않는다
        const current = await buildCycleView(store, cycles, cycle.cycleId);
        if (current && TERMINAL_CYCLE.has(current.state)) return json(res, 409, { error: `Cycle ${cycle.cycleId} 은 이미 ${current.state} 라 Run 을 등록할 수 없음` });
        const run = { runId: b.runId ?? randomUUID(), cycleId: cycle.cycleId, targetId: b.targetId, createdAt: new Date().toISOString() };
        const outcome = await cycles.registerRun(run);
        if (outcome === 'duplicate') return json(res, 409, { error: `Run ${run.runId} 이 이미 등록됨` });
        if (outcome === 'no-cycle') return json(res, 404, { error: '모르는 Cycle' });
        return json(res, 201, run);
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && parts[0] === 'runs' && parts.length === 1) {
        const ids = await store.runIds();
        return json(res, 200, await Promise.all(ids.map(async (id) => summarizeRun(projectRun(await store.eventsForRun(id))))));
      }
      if (req.method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
        const events = await store.eventsForRun(parts[1]!);
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
  // keep-alive 로 남은 유휴 연결 때문에 close 가 매달리지 않도록 함께 끊는다
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
