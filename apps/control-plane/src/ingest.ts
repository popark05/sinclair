// Ingest: Reporter 가 보낸 배치를 원소마다 검증해 저장한다. 하나가 잘못돼도 나머지는 저장한다(원소 단위 멱등).
import { parseRunEvent } from '@sinclair/protocol';
import type { EventStore } from './store.ts';

export interface IngestResponse {
  accepted: number;
  duplicate: number;
  /** 검증에 걸린 원소. eventId 는 입력에 문자열로 있었을 때만 */
  rejected: Array<{ index: number; eventId?: string; errors: string[] }>;
}

export async function ingestBatch(store: EventStore, batch: unknown[]): Promise<IngestResponse> {
  const response: IngestResponse = { accepted: 0, duplicate: 0, rejected: [] };
  for (const [index, item] of batch.entries()) {
    const parsed = parseRunEvent(item);
    if (!parsed.ok) {
      const eventId = typeof item === 'object' && item !== null && typeof (item as { eventId?: unknown }).eventId === 'string' ? (item as { eventId: string }).eventId : undefined;
      response.rejected.push({ index, ...(eventId !== undefined ? { eventId } : {}), errors: parsed.errors });
      continue;
    }
    response[await store.append(parsed.event)]++;
  }
  return response;
}
