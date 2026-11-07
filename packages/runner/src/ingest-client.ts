// control-plane `POST /ingest` 로 배치 하나를 보내는 전송 계층. HTTP Reporter 와 runner-agent 의 스풀 Reporter 가 같이 쓴다.
// 판정: 'done'(200, rejected 포함) / 'retry'(5xx, 408/429, 연결 오류) / 'split'(413 본문 초과 → 호출자가 쪼갠다).
import type { RunEvent } from '@sinclair/protocol';

export interface IngestResponseShape { accepted?: number; duplicate?: number; rejected?: Array<{ index: number; eventId?: string; errors: string[] }> }

export type IngestOutcome =
  /** ok: Ingest 가 200 으로 처리함(rejected 가 있어도). false 면 다른 상태로 거부돼 저장되지 않았고 재시도도 무의미 */
  | { kind: 'done'; ok: boolean; accepted: number; duplicate: number; rejected: Array<{ index: number; eventId?: string; errors: string[] }>; warnings: string[] }
  | { kind: 'retry'; reason: string }
  | { kind: 'split' };

/** 재시도해도 결과가 달라질 수 있는 상태 */
const RETRYABLE_STATUS = new Set([408, 429]);

export async function postIngestBatch(url: string, batch: RunEvent[], doFetch: typeof fetch = fetch, signal?: AbortSignal): Promise<IngestOutcome> {
  let res: Response;
  try {
    res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), ...(signal ? { signal } : {}) });
  } catch (err) {
    return { kind: 'retry', reason: err instanceof Error ? err.message : String(err) }; // 연결 거부·끊김·취소
  }
  if (res.status >= 500 || RETRYABLE_STATUS.has(res.status)) return { kind: 'retry', reason: `HTTP ${res.status}` };
  if (res.status === 413) return { kind: 'split' };
  if (res.status !== 200) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return { kind: 'done', ok: false, accepted: 0, duplicate: 0, rejected: [], warnings: [`Ingest 가 배치(${batch.length}건, ${batch[0]?.eventId}…)를 ${res.status} 로 거부: ${text}`] };
  }
  let body: IngestResponseShape | undefined;
  try { body = (await res.json()) as IngestResponseShape; } catch { body = undefined; }
  if (!body || typeof body.accepted !== 'number') return { kind: 'done', ok: false, accepted: 0, duplicate: 0, rejected: [], warnings: [`Ingest 응답을 읽을 수 없음(${batch.length}건, ${batch[0]?.eventId}…)`] };
  const rejected = body.rejected ?? [];
  return { kind: 'done', ok: true, accepted: body.accepted, duplicate: body.duplicate ?? 0, rejected, warnings: rejected.map((r) => `이벤트 ${r.eventId ?? `#${r.index}`} 거부: ${r.errors.join(', ')}`) };
}
