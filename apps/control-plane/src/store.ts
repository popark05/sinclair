// EventStore: RunEvent 를 eventId 로 멱등 저장한다. 투영은 저장하지 않는다(projection.ts 가 조회 시 계산).
// 구현체는 test/event-store-suite.ts 를 통과해야 한다. 인메모리는 테스트·개발용, SQLite(04)가 운영용.
import type { RunEvent } from '@sinclair/protocol';

export type AppendOutcome = 'accepted' | 'duplicate';

export interface EventStore {
  /** 같은 eventId 가 이미 있으면 'duplicate' 를 돌려주고 아무것도 바꾸지 않는다 */
  append(event: RunEvent): Promise<AppendOutcome>;
  /** 저장된 순서대로. 호출자가 바꿔도 저장소에 영향이 없어야 한다 */
  eventsForRun(runId: string): Promise<RunEvent[]>;
  /** 처음 본 순서 */
  runIds(): Promise<string[]>;
  /** 이 Run 에 이벤트가 하나라도 있는지(클레임 거르기용). 이벤트를 다 읽지 않는다 — 클레임은 폴링마다 끝난 Run 이력 전체를 훑는다 */
  hasEvents?(runId: string): Promise<boolean>;
  close?(): Promise<void>;
}

export function createMemoryEventStore(): EventStore {
  const byId = new Map<string, RunEvent>();
  const byRun = new Map<string, RunEvent[]>();
  const copy = (e: RunEvent): RunEvent => structuredClone(e);
  return {
    async hasEvents(runId) {
      return (byRun.get(runId)?.length ?? 0) > 0;
    },
    async append(event) {
      if (byId.has(event.eventId)) return 'duplicate';
      const stored = copy(event);
      byId.set(stored.eventId, stored);
      let list = byRun.get(stored.runId);
      if (!list) { list = []; byRun.set(stored.runId, list); }
      list.push(stored);
      return 'accepted';
    },
    async eventsForRun(runId) {
      return (byRun.get(runId) ?? []).map(copy);
    },
    async runIds() {
      return [...byRun.keys()];
    },
  };
}
