// 디스크 스풀 Reporter: 이벤트를 먼저 run 별 로컬 파일에 쓰고 거기서 control-plane 으로 보낸다.
// 파일: <dir>/<runId>.jsonl(이벤트 한 줄씩 append-only), <runId>.ack(ack 된 줄 수, 임시 파일 + rename 으로 원자적), <runId>.meta.json(control-plane URL 등).
// 프로세스가 죽거나 서버가 오래 내려가도 `sinclair-agent resume` 이 미ack 줄을 같은 eventId 로 이어 보낸다(Ingest 멱등).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunEvent } from '@sinclair/protocol';
import { parseRunEvent } from '@sinclair/protocol';
import { postIngestBatch, type Reporter } from '@sinclair/runner';

export interface SpoolMeta { runId: string; controlPlane: string; cycleId?: string; targetId?: string; createdAt: string }

export interface SpoolOptions {
  dir: string;
  runId: string;
  /** 예: http://127.0.0.1:4780 (경로 없이) */
  controlPlane: string;
  cycleId?: string;
  targetId?: string;
  /** 한 번에 보내는 최대 줄 수(기본 100, HTTP Reporter 와 같음) */
  batchSize?: number;
  /** 배치가 차지 않아도 이 시간마다 보낸다(기본 500ms) */
  flushIntervalMs?: number;
  /** 첫 재시도 대기(기본 500ms), 두 배씩, 상한(기본 10초) */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** flush 가 재시도에 쓸 총 시간(기본 60초). 넘기면 미전송분을 스풀에 남기고 경고로 돌아온다 — 그 뒤는 resume 의 몫 */
  maxRetryMs?: number;
  fetch?: typeof fetch;
}

export interface SpoolReporter extends Reporter {
  readonly warnings: readonly string[];
  readonly stats: Readonly<{ written: number; acked: number; sent: number; accepted: number; duplicate: number; rejected: number; retries: number }>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly files: { events: string; ack: string; meta: string };
}

export const spoolFiles = (dir: string, runId: string) => ({ events: path.join(dir, `${runId}.jsonl`), ack: path.join(dir, `${runId}.ack`), meta: path.join(dir, `${runId}.meta.json`) });

export function readAck(ackFile: string): number {
  try { const n = Number(fs.readFileSync(ackFile, 'utf8').trim()); return Number.isInteger(n) && n >= 0 ? n : 0; } catch { return 0; }
}

export function writeAck(ackFile: string, n: number): void {
  const tmp = `${ackFile}.tmp`;
  fs.writeFileSync(tmp, String(n));
  fs.renameSync(tmp, ackFile); // 부분 쓰기가 남지 않도록 원자적으로 교체
}

/** 스풀 파일을 줄 단위로 파싱한다. 줄 번호가 ack 의 단위라 깨진 줄은 undefined 로 자리를 지키고 경고한다(마지막 줄이 깨졌으면 부분 쓰기) */
export function readSpoolLines(eventsFile: string): { lines: Array<RunEvent | undefined>; warnings: string[] } {
  let text: string;
  try { text = fs.readFileSync(eventsFile, 'utf8'); } catch { return { lines: [], warnings: [] }; }
  const raw = text.split('\n');
  if (raw.at(-1) === '') raw.pop();
  const warnings: string[] = [];
  const lines = raw.map((line, i) => {
    let parsed: ReturnType<typeof parseRunEvent>;
    try { parsed = parseRunEvent(JSON.parse(line)); } catch { parsed = { ok: false, errors: ['JSON 이 아님'] }; }
    if (parsed.ok) return parsed.event;
    warnings.push(`${path.basename(eventsFile)} ${i + 1}번째 줄 건너뜀${i === raw.length - 1 ? '(마지막 줄, 부분 쓰기로 보임)' : ''}: ${parsed.errors.join(', ')}`);
    return undefined;
  });
  return { lines, warnings };
}

/** 미ack 이벤트를 배치로 보내며 ack 를 전진시킨다. 예산 안에 다 못 보내면 false. 줄 번호 기준이라 건너뛴 줄은 ack 에서 제외하지 않고 함께 넘긴다 */
export async function drainSpool(opts: {
  files: { events: string; ack: string }; controlPlane: string; batchSize?: number; backoffMs?: number; maxBackoffMs?: number; maxRetryMs?: number;
  fetch?: typeof fetch; signal?: AbortSignal; onWarning?: (w: string) => void; stats?: { sent: number; accepted: number; duplicate: number; rejected: number; retries: number; acked: number };
}): Promise<{ complete: boolean; warnings: string[] }> {
  const url = `${opts.controlPlane.replace(/\/$/, '')}/ingest`;
  const batchSize = opts.batchSize ?? 100;
  const maxRetryMs = opts.maxRetryMs ?? 60_000;
  const warnings: string[] = [];
  const warn = (w: string) => { warnings.push(w); opts.onWarning?.(w); };
  const stats = opts.stats ?? { sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0, acked: 0 };
  const started = Date.now();
  let wait = opts.backoffMs ?? 500;

  const { lines, warnings: parseWarnings } = readSpoolLines(opts.files.events);
  let acked = readAck(opts.files.ack);
  if (acked > lines.length) acked = lines.length;
  // 아직 ack 되지 않은 구간의 깨진 줄만 경고한다(이미 넘어간 줄은 전에 경고했다)
  for (const w of parseWarnings) { const n = Number(/ (\d+)번째 줄/.exec(w)?.[1]); if (!(n > 0) || n > acked) warn(w); }

  const sendBatch = async (batch: RunEvent[]): Promise<boolean> => {
    while (!opts.signal?.aborted) {
      const outcome = await postIngestBatch(url, batch, opts.fetch, opts.signal);
      if (outcome.kind === 'done') {
        for (const w of outcome.warnings) warn(w);
        if (outcome.ok) { stats.sent += batch.length; stats.accepted += outcome.accepted; stats.duplicate += outcome.duplicate; stats.rejected += outcome.rejected.length; }
        return true;
      }
      if (outcome.kind === 'split') {
        if (batch.length === 1) { warn(`이벤트 ${batch[0]!.eventId} 가 Ingest 본문 상한을 넘어 버림`); return true; }
        const mid = Math.ceil(batch.length / 2);
        return (await sendBatch(batch.slice(0, mid))) && (await sendBatch(batch.slice(mid)));
      }
      stats.retries++;
      if (Date.now() - started + wait > maxRetryMs) return false;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, wait);
        function done(): void { clearTimeout(t); opts.signal?.removeEventListener('abort', done); resolve(); }
        opts.signal?.addEventListener('abort', done, { once: true });
      });
      wait = Math.min(wait * 2, opts.maxBackoffMs ?? 10_000);
    }
    return false;
  };

  while (acked < lines.length) {
    const end = Math.min(acked + batchSize, lines.length);
    const batch = lines.slice(acked, end).filter((e): e is RunEvent => e !== undefined);
    if (batch.length > 0 && !(await sendBatch(batch))) return { complete: false, warnings };
    acked = end;
    writeAck(opts.files.ack, acked);
    stats.acked = acked;
  }
  return { complete: true, warnings };
}

export function createSpoolReporter(options: SpoolOptions): SpoolReporter {
  const files = spoolFiles(options.dir, options.runId);
  fs.mkdirSync(options.dir, { recursive: true });
  const meta: SpoolMeta = { runId: options.runId, controlPlane: options.controlPlane, ...(options.cycleId ? { cycleId: options.cycleId } : {}), ...(options.targetId ? { targetId: options.targetId } : {}), createdAt: new Date().toISOString() };
  fs.writeFileSync(files.meta, JSON.stringify(meta));
  if (!fs.existsSync(files.events)) fs.writeFileSync(files.events, '');

  const warnings: string[] = [];
  const stats = { written: 0, acked: readAck(files.ack), sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0 };
  const aborter = new AbortController();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<{ complete: boolean }> | undefined;

  const drain = (): Promise<{ complete: boolean }> => {
    if (draining) return draining;
    if (closed) return Promise.resolve({ complete: false });
    let run: Promise<{ complete: boolean }> | undefined;
    run = drainSpool({ files, controlPlane: options.controlPlane, ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}), ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
      ...(options.maxBackoffMs !== undefined ? { maxBackoffMs: options.maxBackoffMs } : {}), ...(options.maxRetryMs !== undefined ? { maxRetryMs: options.maxRetryMs } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
      signal: aborter.signal, onWarning: (w) => warnings.push(w), stats })
      .finally(() => { if (draining === run) draining = undefined; });
    draining = run;
    return run;
  };
  const schedule = (): void => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, options.flushIntervalMs ?? 500);
    timer.unref?.();
  };

  return {
    files, warnings, stats,
    onEvent(event) {
      if (closed) return;
      fs.appendFileSync(files.events, `${JSON.stringify(event)}\n`); // 발생 즉시 디스크에. 한 줄이라 짧게 막힌다
      stats.written++;
      if (stats.written - stats.acked >= (options.batchSize ?? 100)) void drain(); else schedule();
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = undefined; }
      const { complete } = await drain();
      if (!complete) { warnings.push(`재시도 예산 안에 다 보내지 못함: 미전송 ${stats.written - stats.acked}건이 ${files.events} 에 남음 (sinclair-agent resume 으로 이어 보냄)`); return; }
      if (stats.written > stats.acked) await drain(); // drain 중 들어온 줄
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      aborter.abort();
      await draining?.catch(() => undefined);
      // 다 보냈으면 스풀을 치운다. 남아 있으면 resume 의 몫
      if (stats.acked >= stats.written) for (const f of Object.values(files)) fs.rmSync(f, { force: true });
    },
  };
}

/** 스풀 디렉터리의 미완 run 들을 이어 보낸다. 다 보낸 run 의 파일은 지운다 */
export async function resumeSpool(opts: { dir: string; controlPlane?: string; fetch?: typeof fetch; maxRetryMs?: number; backoffMs?: number; maxBackoffMs?: number; log?: (line: string) => void }): Promise<{ resumed: string[]; pending: string[]; warnings: string[] }> {
  const log = opts.log ?? (() => {});
  const resumed: string[] = []; const pending: string[] = []; const warnings: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(opts.dir); } catch { return { resumed, pending, warnings }; }
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const runId = name.slice(0, -'.jsonl'.length);
    const files = spoolFiles(opts.dir, runId);
    let meta: SpoolMeta | undefined;
    try { meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')) as SpoolMeta; } catch { meta = undefined; }
    const controlPlane = opts.controlPlane ?? meta?.controlPlane;
    if (!controlPlane) { warnings.push(`${runId}: meta 가 없어 control-plane 주소를 모름(--control-plane 으로 지정)`); pending.push(runId); continue; }
    const stats = { sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0, acked: readAck(files.ack) };
    const before = stats.acked;
    const result = await drainSpool({ files, controlPlane, stats, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.maxRetryMs !== undefined ? { maxRetryMs: opts.maxRetryMs } : {}),
      ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), ...(opts.maxBackoffMs !== undefined ? { maxBackoffMs: opts.maxBackoffMs } : {}), onWarning: (w) => warnings.push(w) });
    log(`${runId}: ${result.complete ? '완료' : '미완'} (ack ${before} → ${stats.acked}, 전송 ${stats.sent}, accepted ${stats.accepted}, duplicate ${stats.duplicate}, retries ${stats.retries})`);
    if (result.complete) { resumed.push(runId); for (const f of Object.values(files)) fs.rmSync(f, { force: true }); }
    else pending.push(runId);
  }
  return { resumed, pending, warnings };
}
