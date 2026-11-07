// EventStore 구현체가 공통으로 통과해야 하는 스위트. 인메모리(02)와 SQLite(04)가 같은 스위트를 돌린다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import type { EventStore } from '../src/index.ts';

const ev = (eventId: string, runId: string, type: 'run.started' | 'run.finished', s = 0): RunEvent =>
  type === 'run.started'
    ? { schema: 1, eventId, runId, at: `2026-11-07T00:00:0${s}.000Z`, type, targetId: 't' }
    : { schema: 1, eventId, runId, at: `2026-11-07T00:00:0${s}.000Z`, type, state: 'finished' };

export function eventStoreSuite(name: string, makeStore: () => Promise<EventStore> | EventStore): void {
  describe(`EventStore 계약: ${name}`, () => {
    let store: EventStore;
    beforeEach(async () => { store = await makeStore(); });
    afterEach(async () => { await store.close?.(); });

    it('처음 보는 eventId 는 accepted, 같은 eventId 를 다시 넣으면 duplicate 이고 한 번만 저장된다', async () => {
      const a = ev('e1', 'r1', 'run.started');
      expect(await store.append(a)).toBe('accepted');
      expect(await store.append({ ...a, at: '2026-11-07T09:00:00.000Z' })).toBe('duplicate'); // 내용이 달라도 id 가 같으면 중복
      expect(await store.eventsForRun('r1')).toEqual([a]); // 처음 것이 남는다
    });

    it('run 별로 이벤트를 돌려주고, 모르는 run 은 빈 목록이다', async () => {
      await store.append(ev('e1', 'r1', 'run.started', 0));
      await store.append(ev('e2', 'r2', 'run.started', 1));
      await store.append(ev('e3', 'r1', 'run.finished', 2));
      expect((await store.eventsForRun('r1')).map((e) => e.eventId)).toEqual(['e1', 'e3']);
      expect((await store.eventsForRun('r2')).map((e) => e.eventId)).toEqual(['e2']);
      expect(await store.eventsForRun('없음')).toEqual([]);
    });

    it('runIds 는 저장된 run 을 처음 본 순서로 돌려준다', async () => {
      await store.append(ev('e1', 'r2', 'run.started'));
      await store.append(ev('e2', 'r1', 'run.started'));
      await store.append(ev('e3', 'r2', 'run.finished'));
      expect(await store.runIds()).toEqual(['r2', 'r1']);
    });

    it('돌려준 이벤트를 호출자가 바꿔도 저장소는 바뀌지 않는다', async () => {
      await store.append(ev('e1', 'r1', 'run.started'));
      const [got] = await store.eventsForRun('r1');
      (got as { runId: string }).runId = '변조';
      expect((await store.eventsForRun('r1'))[0]!.runId).toBe('r1');
    });
  });
}
