// HTTP 표면. 127.0.0.1 에만 바인딩한다. 인증은 아직 없다(티켓 범위 밖).
//   POST /ingest             RunEvent[] 배치 → IngestResponse
//   GET  /runs               run 요약 목록
//   GET  /runs/:id           RunView (projection.ts)
//   POST /cycles             { cycleId?, build, targets[](이름 | {id, platform, model?, osVersion?}), requiredTags?, suite?{tests,tags?,retries?}, retryLimit? } → CycleRecord (201)
//   GET  /cycles             CycleRecord 목록
//   GET  /cycles/:id         CycleView (verdict.ts: 상태·Verdict·매트릭스)
//   POST /cycles/:id/runs    { targetId, runId? } → RunRegistration (201)
//   POST /runs/claim         { agentId, targetId?, devices?, targets? } → { run(lease.deviceId), leaseTtlMs, warning? } (200) | 없음 (204)
//                            targetId 없으면 서버가 고른다: 이름 타깃은 targets 에 선언됐을 때, 조건 타깃은 맞는 빈 기기가 있을 때
//   POST /runs/:id/heartbeat { agentId } → { expiresAt } (200) | 409 not-owner·replaced | 404
//   PUT  /fleet/nodes/:agentId { devices[] } → { ttlMs } (200) | 400 — 노드의 기기 보고(통째 교체)
//   GET  /fleet              → FleetView(노드별 기기와 idle/untrusted/offline)
//   GET  /health             200
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ingestBatch } from './ingest.ts';
import { projectRun, type RunView } from './projection.ts';
import type { EventStore } from './store.ts';
import { createMemoryCycleStore, type CycleStore, type RunRegistration } from './cycle-store.ts';
import { MAX_RETRY_LIMIT } from './verdict.ts';
import { matchesTarget, parseCycleTargets, parseNodeReport, type NodeDevice } from '@sinclair/protocol';
import { buildFleetView, createMemoryFleetStore, type FleetStore } from './fleet.ts';
import { buildCycleView, sweepAbandoned, sweepAllAbandoned } from './cycle-view.ts';

export interface ControlPlaneOptions {
  port?: number;
  host?: string;
  maxBodyBytes?: number;
  /** Cycle/Run 등록 저장소. 없으면 인메모리 */
  cycles?: CycleStore;
  /** Fleet 노드 보고 저장소. 없으면 인메모리 */
  fleet?: FleetStore;
  /** 클레임 lease 수명(기본 60초). 버려진 Run 판정 유예도 같은 값이다. 에이전트는 이 값의 1/3 마다 heartbeat 한다. 한 테스트가 1분 넘게 조용할 수 있어 짧게 잡지 않는다 */
  leaseTtlMs?: number;
  /** 테스트용 시계 */
  now?: () => number;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;
/** 러너 MAX_RETRIES 와 같은 값. apps 는 러너를 import 하지 않으므로 숫자를 따로 둔다(apps/runner-agent/test/args.test.ts 가 같음을 확인) */
export const MAX_SUITE_RETRIES = 5;

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
  const fleet = opts.fleet ?? createMemoryFleetStore();
  // 노드 보고 TTL 은 Run lease TTL 과 같다: 같은 노드의 heartbeat 와 보고가 같은 박자로 끊기고 살아난다(노드는 TTL/3 마다 보고)
  const nodeTtlMs = (): number => opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  /** 지금 바쁜 기기 → Run. 끝난 Run(run.finished 가 들어옴)의 기기는 lease 가 남아 있어도 풀린 것으로 본다. 바쁜 기기는 노드마다 몇 대라 Run 이벤트 조회가 싸다 */
  const busyDevices = async (nowMs: number): Promise<{ busy: Map<string, string>; finished: Set<string> }> => {
    const busy = new Map<string, string>();
    const finished = new Set<string>();
    for (const l of await cycles.deviceLeases(nowMs)) {
      if (projectRun(await store.eventsForRun(l.runId)).finishedAt !== undefined) finished.add(l.runId);
      else busy.set(l.deviceId, l.runId);
    }
    return { busy, finished };
  };
  const sweepOpts = () => ({ nowMs: (opts.now ?? Date.now)(), graceMs: opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS });
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
        if (!isRecord(b) || typeof b.build !== 'string' || !b.build) return json(res, 400, { error: 'build(문자열)와 targets 가 필요함' });
        // 타깃은 이름 문자열(노드가 선언) 또는 기기 선택 조건(device-fleet 03). 같은 id 가 두 번이면 거부한다(예전처럼 조용히 합치지 않는다)
        const targets = parseCycleTargets(b.targets);
        if (!targets.ok) return json(res, 400, { error: 'targets 가 올바르지 않음', errors: targets.errors });
        if (b.requiredTags !== undefined && !isStringArray(b.requiredTags)) return json(res, 400, { error: 'requiredTags 는 문자열 배열이어야 함' });
        if (!optionalId(b.cycleId)) return json(res, 400, { error: 'cycleId 는 비어 있지 않은 문자열이어야 함' });
        if (b.suite !== undefined && (!isRecord(b.suite) || typeof b.suite.tests !== 'string' || !b.suite.tests || (b.suite.tags !== undefined && !isStringArray(b.suite.tags)))) return json(res, 400, { error: 'suite 는 { tests: 문자열, tags?: 문자열 배열, retries?: 정수 } 이어야 함' });
        if (isRecord(b.suite) && b.suite.retries !== undefined && (typeof b.suite.retries !== 'number' || !Number.isInteger(b.suite.retries) || b.suite.retries < 0 || b.suite.retries > MAX_SUITE_RETRIES)) return json(res, 400, { error: `suite.retries 는 0~${MAX_SUITE_RETRIES} 의 정수여야 함` });
        if (b.retryLimit !== undefined && (typeof b.retryLimit !== 'number' || !Number.isInteger(b.retryLimit) || b.retryLimit < 0 || b.retryLimit > MAX_RETRY_LIMIT)) return json(res, 400, { error: `retryLimit 은 0~${MAX_RETRY_LIMIT} 의 정수여야 함` });
        const suite = b.suite as { tests: string; tags?: string[]; retries?: number } | undefined;
        const cycle = {
          ...(typeof b.retryLimit === 'number' ? { retryLimit: b.retryLimit } : {}),
          cycleId: b.cycleId ?? randomUUID(), build: b.build, targets: targets.ids, ...(Object.keys(targets.selectors).length ? { targetSelectors: targets.selectors } : {}), requiredTags: (b.requiredTags as string[] | undefined) ?? [],
          ...(suite ? { suite: { tests: suite.tests, ...(suite.tags ? { tags: suite.tags } : {}), ...(suite.retries !== undefined ? { retries: suite.retries } : {}) } } : {}), createdAt: new Date().toISOString(),
        };
        if ((await cycles.createCycle(cycle)) === 'duplicate') return json(res, 409, { error: `Cycle ${cycle.cycleId} 가 이미 있음`, code: 'cycle-exists' });
        return json(res, 201, cycle);
      }
      if (req.method === 'GET' && url.pathname === '/cycles') return json(res, 200, await cycles.listCycles());
      if (req.method === 'GET' && parts[0] === 'cycles' && parts.length === 2) {
        // 조회도 정리 시점이다: 별도 스케줄러 없이 클레임·조회에서 버려진 Run 을 닫는다
        await sweepAbandoned(store, cycles, parts[1]!, sweepOpts());
        const view = await buildCycleView(store, cycles, parts[1]!);
        return view ? json(res, 200, view) : json(res, 404, { error: '모르는 Cycle' });
      }
      if (req.method === 'POST' && parts[0] === 'cycles' && parts.length === 3 && parts[2] === 'runs') {
        const cycle = await cycles.getCycle(parts[1]!);
        if (!cycle) return json(res, 404, { error: '모르는 Cycle', code: 'cycle-not-found' });
        const read = await readJson(req, res);
        if (!read) return;
        const b = read.body;
        if (!isRecord(b) || typeof b.targetId !== 'string' || !cycle.targets.includes(b.targetId)) return json(res, 400, { error: `targetId 는 Cycle 의 targets(${cycle.targets.join(', ')}) 중 하나여야 함` });
        if (!optionalId(b.runId)) return json(res, 400, { error: 'runId 는 비어 있지 않은 문자열이어야 함' });
        // 끝난 Cycle 의 Verdict 는 바뀌지 않아야 하므로 Run 을 더 받지 않는다
        const current = await buildCycleView(store, cycles, cycle.cycleId);
        // 클라이언트가 상태 코드만으로 "끝난 Cycle" 과 "이미 있는 Run" 을 가를 수 없으므로 code 를 함께 준다
        if (current && TERMINAL_CYCLE.has(current.state)) return json(res, 409, { error: `Cycle ${cycle.cycleId} 은 이미 ${current.state} 라 Run 을 등록할 수 없음`, code: 'cycle-finished' });
        const run = { runId: b.runId ?? randomUUID(), cycleId: cycle.cycleId, targetId: b.targetId, createdAt: new Date().toISOString() };
        const outcome = await cycles.registerRun(run);
        if (outcome === 'duplicate') return json(res, 409, { error: `Run ${run.runId} 이 이미 등록됨`, code: 'run-exists' });
        if (outcome === 'no-cycle') return json(res, 404, { error: '모르는 Cycle', code: 'cycle-not-found' });
        return json(res, 201, run);
      }
      if (req.method === 'POST' && url.pathname === '/runs/claim') {
        const read = await readJson(req, res);
        if (!read) return;
        const b = read.body;
        if (!isRecord(b) || typeof b.agentId !== 'string' || !b.agentId) return json(res, 400, { error: 'agentId(문자열)가 필요함' });
        if (b.targetId !== undefined && (typeof b.targetId !== 'string' || !b.targetId)) return json(res, 400, { error: 'targetId 는 비어 있지 않은 문자열이어야 함' });
        if (b.devices !== undefined && !isStringArray(b.devices)) return json(res, 400, { error: 'devices 는 기기 id 문자열 배열이어야 함' });
        if (b.targets !== undefined && !isStringArray(b.targets)) return json(res, 400, { error: 'targets 는 이 노드가 맡는 이름 타깃의 문자열 배열이어야 함' });
        const devices = b.devices as string[] | undefined;
        const targetId = b.targetId as string | undefined;
        // targetId 없이 클레임하면 서버가 타깃을 고른다: 그러려면 내놓을 기기가 있어야 한다
        if (targetId === undefined && !devices) return json(res, 400, { error: 'targetId 없이 클레임하려면 devices 가 필요함' });
        const declared = new Set((b.targets as string[] | undefined) ?? []);
        const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
        await sweepAllAbandoned(store, cycles, sweepOpts()); // 버려진 Run 의 대체 Run 이 이 클레임에서 바로 잡히게
        const nowMs = (opts.now ?? Date.now)();
        const { finished } = devices ? await busyDevices(nowMs) : { finished: new Set<string>() };
        // 조건 타깃에 맞출 기기 속성은 Fleet 보고에서 안다(플랫폼·모델·OS 는 거의 바뀌지 않는다). 보고하지 않은 기기는 조건 타깃을 받지 못한다
        const known = new Map<string, NodeDevice>();
        if (devices) for (const n of await fleet.listNodes()) for (const d of n.devices) if (!known.has(d.id) || n.agentId === b.agentId) known.set(d.id, d);
        const cycleCache = new Map<string, Awaited<ReturnType<typeof cycles.getCycle>>>();
        const eligible = async (reg: RunRegistration): Promise<boolean | readonly string[]> => {
          if (!cycleCache.has(reg.cycleId)) cycleCache.set(reg.cycleId, await cycles.getCycle(reg.cycleId));
          const selector = cycleCache.get(reg.cycleId)?.targetSelectors?.[reg.targetId];
          if (selector) {
            if (!devices) return false; // 기기 없이 클레임하는 구버전은 조건을 확인할 수 없다
            const fit = devices.filter((id) => { const d = known.get(id); return !!d && matchesTarget(d, selector); });
            return fit.length ? fit : false;
          }
          // 이름 타깃: targetId 로 직접 청했거나(기존 방식) 노드가 그 이름을 맡겠다고 선언했을 때
          return targetId !== undefined || declared.has(reg.targetId);
        };
        const run = await cycles.claimRun(targetId, b.agentId, nowMs, ttl, async (runId) => (await store.eventsForRun(runId)).length > 0, { ...(devices ? { devices, finishedRuns: finished } : {}), eligible });
        if (!run) { res.writeHead(204).end(); return; }
        const cycle = await cycles.getCycle(run.cycleId);
        // 구버전 에이전트(devices 없음)도 지금처럼 Run 을 받는다. 다만 기기 lease 가 없어 같은 기기를 다른 Run 이 동시에 쓸 수 있음을 알린다
        const warning = devices ? undefined : '기기 없이 클레임함: 기기 lease 가 없어 다른 Run 과 같은 기기를 동시에 쓸 수 있음(에이전트를 올리면 사라진다)';
        return json(res, 200, { run, leaseTtlMs: ttl, ...(cycle?.suite ? { suite: cycle.suite } : {}), ...(warning ? { warning } : {}) });
      }
      if (req.method === 'POST' && parts[0] === 'runs' && parts.length === 3 && parts[2] === 'heartbeat') {
        const read = await readJson(req, res);
        if (!read) return;
        const b = read.body;
        if (!isRecord(b) || typeof b.agentId !== 'string' || !b.agentId) return json(res, 400, { error: 'agentId(문자열)가 필요함' });
        const result = await cycles.heartbeat(parts[1]!, b.agentId, (opts.now ?? Date.now)(), opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
        if (result.outcome === 'no-run') return json(res, 404, { error: '모르는 Run', code: 'run-not-found' });
        if (result.outcome === 'not-owner') return json(res, 409, { error: '이 에이전트의 lease 가 아님', code: 'not-owner' });
        // 에이전트는 409 를 lease 상실로 보고 러너를 취소한다(대체 Run 이 그 몫을 돌린다)
        if (result.outcome === 'replaced') return json(res, 409, { error: `버려진 Run 으로 정리돼 ${result.replacedBy} 로 대체됨`, code: 'replaced', replacedBy: result.replacedBy });
        return json(res, 200, { expiresAt: result.expiresAt });
      }
      if (req.method === 'PUT' && parts[0] === 'fleet' && parts[1] === 'nodes' && parts.length === 3) {
        const agentId = parts[2]!; // filter(Boolean) 로 빈 id 는 이 경로에 오지 않는다
        const read = await readJson(req, res);
        if (!read) return;
        const parsed = parseNodeReport(read.body);
        if (!parsed.ok) return json(res, 400, { error: '노드 보고가 올바르지 않음', errors: parsed.errors });
        await fleet.reportNode(agentId, parsed.value, (opts.now ?? Date.now)());
        return json(res, 200, { ttlMs: nodeTtlMs() });
      }
      if (req.method === 'GET' && url.pathname === '/fleet') {
        const nowMs = (opts.now ?? Date.now)();
        return json(res, 200, buildFleetView(await fleet.listNodes(), nowMs, nodeTtlMs(), (await busyDevices(nowMs)).busy));
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
