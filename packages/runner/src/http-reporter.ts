// HTTP Reporter: RunEvent 를 모아 control-plane `POST /ingest` 로 배치 전송한다.
// onEvent 는 큐에 넣고 바로 돌아온다(테스트 실행을 막지 않고, 러너가 보류 promise 를 쌓지도 않는다).
// 일시 오류(5xx, 연결 오류)는 같은 eventId 로 다시 보낸다 — Ingest 가 eventId 로 멱등이라 중복 전송이 안전하다.
// 원소 거부(rejected[])와 400 은 다시 보내도 같으므로 재시도하지 않고 경고로 남긴다.
// 재시도는 상한 있는 백오프로 끝없이 한다. 전체 기한은 러너의 reporterFlushTimeoutMs 가 잡는다.
import type { RunEvent } from '@sinclair/protocol';
import type { Reporter } from './runner.ts';

export interface HttpReporterOptions {
  /** 예: http://127.0.0.1:4000/ingest */
  url: string;
  /** 한 번에 보내는 최대 이벤트 수(기본 100). Ingest 본문 상한 8 MB 에 넉넉히 든다 */
  batchSize?: number;
  /** 배치가 차지 않아도 이 시간마다 보낸다(기본 500ms). 긴 테스트에서도 Console 이 진행을 볼 수 있을 만큼 짧게 */
  flushIntervalMs?: number;
  /** 첫 재시도 대기(기본 500ms). 이후 두 배씩, maxBackoffMs(기본 10초)까지 */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** 테스트용 주입. 기본은 전역 fetch */
  fetch?: typeof fetch;
}

export interface HttpReporter extends Reporter {
  readonly warnings: string[];
  flush(): Promise<void>;
  /** 서버 주소가 바뀌었을 때(테스트·재배치). 보류 중인 배치는 새 주소로 간다 */
  setUrl(url: string): void;
  /** 전송 통계 */
  readonly stats: { sent: number; accepted: number; duplicate: number; rejected: number; retries: number };
}

interface IngestResponseShape { accepted: number; duplicate: number; rejected: Array<{ index: number; eventId?: string; errors: string[] }> }

export function createHttpReporter(options: HttpReporterOptions): HttpReporter {
  let url = options.url;
  const batchSize = options.batchSize ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 500;
  const backoffMs = options.backoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 10_000;
  const doFetch = options.fetch ?? fetch;

  const queue: RunEvent[] = [];
  const warnings: string[] = [];
  const stats = { sent: 0, accepted: 0, duplicate: 0, rejected: 0, retries: 0 };
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;

  const sendOnce = async (batch: RunEvent[]): Promise<'done' | 'retry'> => {
    let res: Response;
    try {
      res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
    } catch {
      return 'retry'; // 연결 거부·끊김
    }
    if (res.status >= 500) return 'retry';
    if (res.status !== 200) {
      warnings.push(`Ingest 가 배치(${batch.length}건, ${batch[0]?.eventId}…)를 ${res.status} 로 거부: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return 'done';
    }
    const body = (await res.json().catch(() => undefined)) as IngestResponseShape | undefined;
    if (!body) { warnings.push(`Ingest 응답을 읽을 수 없음(${batch.length}건)`); return 'done'; }
    stats.sent += batch.length; stats.accepted += body.accepted; stats.duplicate += body.duplicate; stats.rejected += body.rejected.length;
    for (const r of body.rejected) warnings.push(`이벤트 ${r.eventId ?? `#${r.index}`} 거부: ${r.errors.join(', ')}`);
    return 'done';
  };

  const sendWithRetry = async (batch: RunEvent[]): Promise<void> => {
    let wait = backoffMs;
    while ((await sendOnce(batch)) === 'retry') {
      stats.retries++;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, maxBackoffMs);
    }
  };

  /** 큐가 빌 때까지 배치를 순서대로 보낸다. 동시에 하나만 돈다(순서 보존) */
  const drain = (): Promise<void> => {
    if (draining) return draining;
    // 빈 큐로 시작하면 아래 IIFE 가 동기적으로 끝나 finally 가 대입보다 먼저 돌고, 끝난 promise 가 draining 에 남는다
    if (queue.length === 0) return Promise.resolve();
    let run: Promise<void> | undefined;
    run = (async () => {
      try {
        while (queue.length > 0) await sendWithRetry(queue.splice(0, batchSize));
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
    timer.unref?.();
  };

  return {
    warnings,
    stats,
    onEvent(event) {
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
    setUrl(next) { url = next; },
  };
}
