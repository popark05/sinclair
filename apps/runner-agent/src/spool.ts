// 디스크 스풀 Reporter: 이벤트를 먼저 run 별 로컬 파일에 쓰고 거기서 control-plane 으로 보낸다.
// 파일: <dir>/<runId>.jsonl(이벤트 한 줄씩 append-only), <runId>.ack(ack 된 줄 수, 임시 파일 + rename 으로 원자적), <runId>.meta.json(control-plane URL 등).
// 프로세스가 죽거나 서버가 오래 내려가도 `sinclair-agent resume` 이 미ack 줄을 같은 eventId 로 이어 보낸다(Ingest 멱등).
// 내구성 범위: appendFileSync 는 OS 버퍼까지라 프로세스 크래시에는 안전하지만 전원 단절은 아니다(fsync 없음, QA 노드 전제).
// 같은 runId 로 다시 열면(크래시 후 `--run` 재실행) 기존 줄을 이어 쓰고 함께 보낸다.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunEvent } from '@sinclair/protocol';
import { parseRunEvent } from '@sinclair/protocol';
import { postIngestBatch, type Reporter } from '@sinclair/runner';

export interface SpoolMeta { runId: string; controlPlane: string; cycleId?: string; targetId?: string; createdAt: string }

/** 전송·재시도 설정. 스풀 Reporter, drainSpool, resumeSpool 이 같은 묶음을 쓴다 */
export interface IngestRetryOptions {
  /** 한 번에 보내는 최대 줄 수(기본 100). 이벤트가 수백 바이트라 Ingest 본문 상한 8 MB 에 넉넉하고, 넘으면 413 으로 쪼갠다 */
  batchSize?: number;
  /** 첫 재시도 대기(기본 500ms, 로컬 재시작·일시 네트워크 흔들림이 보통 1초 안에 끝남), 두 배씩, 상한(기본 10초: 서버 복구 뒤 10초 안에 이어 보냄) */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** 재시도에 쓸 총 시간(기본 60초: 사내 서버 재배포 한 번을 넘길 만큼). 넘기면 미전송분을 스풀에 남기고 경고로 돌아온다 — 그 뒤는 resume 의 몫 */
  maxRetryMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_MAX_RETRY_MS = 60_000;

export interface SpoolOptions extends IngestRetryOptions {
  dir: string;
  runId: string;
  /** 예: http://127.0.0.1:4780 (경로 없이) */
  controlPlane: string;
  cycleId?: string;
  targetId?: string;
  /** 배치가 차지 않아도 이 시간마다 보낸다(기본 500ms, HTTP Reporter 와 같은 이유: Console 이 진행을 볼 수 있을 만큼) */
  flushIntervalMs?: number;
}

const RETRY_KEYS = ['batchSize', 'backoffMs', 'maxBackoffMs', 'maxRetryMs', 'fetch'] as const;
/** 정의된 재시도 옵션만 골라낸다(exactOptionalPropertyTypes 때문에 undefined 를 넘기지 않는다) */
function retryOptions(src: IngestRetryOptions): IngestRetryOptions {
  const out: Record<string, unknown> = {};
  for (const k of RETRY_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out as IngestRetryOptions;
}

export interface SpoolReporter extends Reporter {
  readonly warnings: readonly string[];
  /** written 은 파일의 전체 줄 수(재개 시 기존 줄 포함) */
  readonly stats: Readonly<{ written: number; acked: number; sent: number; accepted: number; duplicate: number; rejected: number; retries: number }>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly files: { events: string; ack: string; meta: string; lock: string };
  /** 러너가 flush 를 기다려야 하는 시간. 재시도 예산보다 짧으면 러너가 먼저 끊어 예산이 무의미해진다 */
  readonly flushBudgetMs: number;
}

export const spoolFiles = (dir: string, runId: string) => ({ events: path.join(dir, `${runId}.jsonl`), ack: path.join(dir, `${runId}.ack`), meta: path.join(dir, `${runId}.meta.json`), lock: path.join(dir, `${runId}.lock`) });

/** lock 파일의 pid 가 살아 있으면 다른 프로세스(같은 머신의 다른 데몬·run)가 이 스풀을 쓰고 있는 것이다 */
export function spoolOwnerAlive(lockFile: string): boolean {
  let pid: number;
  try { pid = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readAck(ackFile: string): number {
  try { const n = Number(fs.readFileSync(ackFile, 'utf8').trim()); return Number.isInteger(n) && n >= 0 ? n : 0; } catch { return 0; }
}

export function writeAck(ackFile: string, n: number): void {
  const tmp = `${ackFile}.tmp`;
  fs.writeFileSync(tmp, String(n));
  fs.renameSync(tmp, ackFile); // 부분 쓰기가 남지 않도록 원자적으로 교체
}

/** 스풀 파일을 줄 단위로 파싱한다. 줄 번호가 ack 의 단위라 깨진 줄은 undefined 로 자리를 지키고 경고한다(마지막 줄이 깨졌으면 부분 쓰기) */
function readSpoolLines(eventsFile: string): { lines: Array<RunEvent | undefined>; skipped: Array<{ line: number; message: string }> } {
  let text: string;
  try { text = fs.readFileSync(eventsFile, 'utf8'); } catch { return { lines: [], skipped: [] }; }
  const raw = text.split('\n');
  if (raw.at(-1) === '') raw.pop();
  const skipped: Array<{ line: number; message: string }> = [];
  const lines = raw.map((line, i) => {
    let parsed: ReturnType<typeof parseRunEvent>;
    try { parsed = parseRunEvent(JSON.parse(line)); } catch { parsed = { ok: false, errors: ['JSON 이 아님'] }; }
    if (parsed.ok) return parsed.event;
    skipped.push({ line: i + 1, message: `${path.basename(eventsFile)} ${i + 1}번째 줄 건너뜀${i === raw.length - 1 ? '(마지막 줄, 부분 쓰기로 보임)' : ''}: ${parsed.errors.join(', ')}` });
    return undefined;
  });
  return { lines, skipped };
}

/** 파일의 줄 수(없으면 0) */
function countLines(eventsFile: string): number {
  return readSpoolLines(eventsFile).lines.length;
}

/** 미ack 이벤트를 배치로 보내며 ack 를 전진시킨다. 예산 안에 다 못 보내면 false. 줄 번호 기준이라 건너뛴 줄은 ack 에서 제외하지 않고 함께 넘긴다 */
export async function drainSpool(opts: IngestRetryOptions & {
  files: { events: string; ack: string }; controlPlane: string;
  signal?: AbortSignal; onWarning?: (w: string) => void; stats?: { sent: number; accepted: number; duplicate: number; rejected: number; retries: number; acked: number };
}): Promise<{ complete: boolean; warnings: string[] }> {
  const url = `${opts.controlPlane.replace(/\/$/, '')}/ingest`;
  const batchSize = opts.batchSize ?? 100;
  const maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const warnings: string[] = [];
  const warn = (w: string) => { warnings.push(w); opts.onWarning?.(w); };
  const stats = opts.stats ?? { sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0, acked: 0 };
  const started = Date.now();
  let wait = opts.backoffMs ?? 500;

  const { lines, skipped } = readSpoolLines(opts.files.events);
  let acked = readAck(opts.files.ack);
  if (acked > lines.length) acked = lines.length;
  // 아직 ack 되지 않은 구간의 깨진 줄만 경고한다(이미 넘어간 줄은 전에 경고했다)
  for (const sk of skipped) if (sk.line > acked) warn(sk.message);

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
  fs.writeFileSync(files.lock, String(process.pid)); // 먼저 잠근다: 열려 있는 동안 resume 이 건드리지 못하게
  fs.writeFileSync(files.meta, JSON.stringify(meta));
  if (!fs.existsSync(files.events)) fs.writeFileSync(files.events, '');

  const warnings: string[] = [];
  // 같은 runId 로 다시 열었을 수 있으니 written 은 파일의 현재 줄 수에서 시작한다(0 에서 시작하면 close 가 옛 미ack 줄을 지운다)
  const stats = { written: countLines(files.events), acked: readAck(files.ack), sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0 };
  if (stats.acked > stats.written) stats.acked = stats.written;
  const aborter = new AbortController();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<{ complete: boolean }> | undefined;

  const drain = (): Promise<{ complete: boolean }> => {
    if (draining) return draining;
    if (closed) return Promise.resolve({ complete: false });
    let run: Promise<{ complete: boolean }> | undefined;
    run = drainSpool({ files, controlPlane: options.controlPlane, ...retryOptions(options), signal: aborter.signal, onWarning: (w) => warnings.push(w), stats })
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
    flushBudgetMs: (options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS) + 5_000, // 예산 + 마지막 배치 왕복 여유
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
      // 파일 기준으로 전부 ack 됐을 때만 스풀을 치운다. 남아 있으면 resume 의 몫(lock 은 항상 푼다)
      if (readAck(files.ack) >= countLines(files.events)) for (const f of Object.values(files)) fs.rmSync(f, { force: true });
      else fs.rmSync(files.lock, { force: true });
    },
  };
}

/** 스풀 디렉터리의 미완 run 들을 이어 보낸다. 다 보낸 run 의 파일은 지운다 */
export async function resumeSpool(opts: IngestRetryOptions & { dir: string; controlPlane?: string; log?: (line: string) => void }): Promise<{ resumed: string[]; pending: string[]; warnings: string[] }> {
  const log = opts.log ?? (() => {});
  const resumed: string[] = []; const pending: string[] = []; const warnings: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(opts.dir); } catch { return { resumed, pending, warnings }; }
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const runId = name.slice(0, -'.jsonl'.length);
    const files = spoolFiles(opts.dir, runId);
    if (spoolOwnerAlive(files.lock)) { log(`${runId}: 다른 프로세스가 쓰는 중(lock), 건너뜀`); continue; }
    let meta: SpoolMeta | undefined;
    try { meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')) as SpoolMeta; } catch { meta = undefined; }
    const controlPlane = opts.controlPlane ?? meta?.controlPlane;
    if (!controlPlane) { warnings.push(`${runId}: meta 가 없어 control-plane 주소를 모름(--control-plane 으로 지정)`); pending.push(runId); continue; }
    const stats = { sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0, acked: readAck(files.ack) };
    const before = stats.acked;
    const result = await drainSpool({ files, controlPlane, stats, ...retryOptions(opts), onWarning: (w) => warnings.push(w) });
    log(`${runId}: ${result.complete ? '완료' : '미완'} (ack ${before} → ${stats.acked}, 전송 ${stats.sent}, accepted ${stats.accepted}, duplicate ${stats.duplicate}, retries ${stats.retries})`);
    if (result.complete) { resumed.push(runId); for (const f of Object.values(files)) fs.rmSync(f, { force: true }); } // 죽은 프로세스의 lock 도 함께
    else pending.push(runId);
  }
  return { resumed, pending, warnings };
}
