// HTTP Reporter: RunEvent 를 모아 control-plane `POST /ingest` 로 배치 전송한다.
// onEvent 는 큐에 넣고 바로 돌아온다(테스트 실행을 막지 않고, 러너가 보류 promise 를 쌓지도 않는다).
// 일시 오류(5xx, 408/429, 연결 오류)는 같은 eventId 로 다시 보낸다 — Ingest 가 eventId 로 멱등이라 중복 전송이 안전하다.
// 원소 거부(rejected[])와 그 밖의 4xx 는 다시 보내도 같으므로 재시도하지 않고 경고로 남긴다. 413(본문 초과)은 배치를 반으로 쪼개 다시 보낸다.
// 재시도는 상한 있는 백오프로 끝없이 한다. 전체 기한은 러너의 reporterFlushTimeoutMs 가 잡고, 러너는 그 뒤 close() 로 재시도를 멈춘다.
import type { RunEvent } from '@sinclair/protocol';
import type { Reporter } from './runner.ts';
import { postIngestBatch } from './ingest-client.ts';

export interface HttpReporterOptions {
  /** 예: http://127.0.0.1:4000/ingest */
  url: string;
  /** 한 번에 보내는 최대 이벤트 수(기본 100). 이벤트는 보통 수백 바이트라 Ingest 본문 상한 8 MB 에 넉넉히 들고, 넘으면 413 으로 쪼갠다 */
  batchSize?: number;
  /** 배치가 차지 않아도 이 시간마다 보낸다(기본 500ms). 긴 테스트에서도 Console 이 진행을 볼 수 있을 만큼 짧게 */
  flushIntervalMs?: number;
  /** 첫 재시도 대기(기본 500ms). 이후 두 배씩 */
  backoffMs?: number;
  /** 재시도 대기 상한(기본 10초). 서버가 오래 내려가 있어도 복구 뒤 10초 안에 이어 보낸다 */
  maxBackoffMs?: number;
  /** 테스트용 주입. 기본은 전역 fetch */
  fetch?: typeof fetch;
}

export interface HttpReporterStats { sent: number; accepted: number; duplicate: number; rejected: number; retries: number }

export interface HttpReporter extends Reporter {
  readonly warnings: readonly string[];
  readonly stats: Readonly<HttpReporterStats>;
  flush(): Promise<void>;
  /** 재시도를 멈추고 남은 큐를 버린다(버린 수는 경고로). 이후 onEvent 는 무시된다 */
  close(): Promise<void>;
}

export function createHttpReporter(options: HttpReporterOptions): HttpReporter {
  const url = new URL(options.url).href; // 잘못된 주소는 재시도 대상이 아니라 설정 오류: 여기서 바로 던진다
  const batchSize = options.batchSize ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 500;
  const backoffMs = options.backoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 10_000;
  const doFetch = options.fetch ?? fetch;

  const queue: RunEvent[] = [];
  const warnings: string[] = [];
  const stats: HttpReporterStats = { sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0 };
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  let closed = false;
  const aborter = new AbortController();

  /** 취소 가능한 대기. close() 되면 바로 깬다 */
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void { clearTimeout(t); aborter.signal.removeEventListener('abort', done); resolve(); }
    aborter.signal.addEventListener('abort', done, { once: true });
  });

  type Outcome = 'done' | 'retry' | 'split';
  const sendOnce = async (batch: RunEvent[]): Promise<Outcome> => {
    const outcome = await postIngestBatch(url, batch, doFetch, aborter.signal);
    if (outcome.kind !== 'done') return outcome.kind;
    warnings.push(...outcome.warnings);
    if (outcome.ok) { stats.sent += batch.length; stats.accepted += outcome.accepted; stats.duplicate += outcome.duplicate; stats.rejected += outcome.rejected.length; }
    return 'done';
  };

  const sendWithRetry = async (batch: RunEvent[]): Promise<void> => {
    let wait = backoffMs;
    while (!closed) {
      const outcome = await sendOnce(batch);
      if (outcome === 'done') return;
      if (outcome === 'split') {
        if (batch.length === 1) { warnings.push(`이벤트 ${batch[0]!.eventId} 가 Ingest 본문 상한을 넘어 버림`); return; }
        const mid = Math.ceil(batch.length / 2);
        await sendWithRetry(batch.slice(0, mid));
        await sendWithRetry(batch.slice(mid));
        return;
      }
      stats.retries++;
      await sleep(wait);
      wait = Math.min(wait * 2, maxBackoffMs);
    }
  };

  /** 큐가 빌 때까지 배치를 순서대로 보낸다. 동시에 하나만 돈다(순서 보존) */
  const drain = (): Promise<void> => {
    if (draining) return draining;
    // 빈 큐로 시작하면 아래 IIFE 가 동기적으로 끝나 finally 가 대입보다 먼저 돌고, 끝난 promise 가 draining 에 남는다
    if (queue.length === 0 || closed) return Promise.resolve();
    let run: Promise<void> | undefined;
    run = (async () => {
      try {
        while (queue.length > 0 && !closed) await sendWithRetry(queue.splice(0, batchSize));
      } finally {
        if (draining === run) draining = undefined;
      }
    })();
    draining = run;
    return run;
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, flushIntervalMs);
    timer.unref?.(); // 보낼 것이 남았어도 프로세스 종료를 막지 않는다. 끝까지 보내려면 flush() 를 기다린다
  };

  return {
    warnings,
    stats,
    onEvent(event) {
      if (closed) return;
      queue.push(event);
      if (queue.length >= batchSize) void drain(); else schedule();
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = undefined; }
      // 진행 중인 drain 이 있으면 그것이 큐를 비울 때까지 기다린다. 그 사이 들어온 이벤트도 같은 루프가 보낸다
      await drain();
      // drain 이 끝난 직후 들어온 이벤트가 있으면 한 번 더
      if (queue.length > 0) await drain();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      aborter.abort();
      await draining?.catch(() => undefined);
      if (queue.length > 0) { warnings.push(`Reporter 종료로 이벤트 ${queue.length}건을 보내지 못함`); queue.length = 0; }
    },
  };
}
