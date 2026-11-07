// CycleStore 구현체가 공통으로 통과해야 하는 스위트(메모리·SQLite).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CycleStore, CycleRecord } from '../src/index.ts';

const cycle = (cycleId: string, n = 0): CycleRecord => ({ cycleId, build: `b${n}`, targets: ['android', 'ios'], requiredTags: ['smoke'], createdAt: `2026-11-07T00:00:0${n}.000Z` });

export function cycleStoreSuite(name: string, makeStore: () => Promise<CycleStore> | CycleStore): void {
  describe(`CycleStore 계약: ${name}`, () => {
    let store: CycleStore;
    beforeEach(async () => { store = await makeStore(); });
    afterEach(async () => { await store.close?.(); });

    it('Cycle 을 만들고 읽는다. 같은 id 는 duplicate 이고 처음 것이 남는다', async () => {
      expect(await store.createCycle(cycle('c1', 1))).toBe('created');
      expect(await store.createCycle(cycle('c1', 2))).toBe('duplicate');
      expect(await store.getCycle('c1')).toEqual(cycle('c1', 1));
      expect(await store.getCycle('없음')).toBeUndefined();
    });

    it('목록은 만든 순서다', async () => {
      await store.createCycle(cycle('c2', 2));
      await store.createCycle(cycle('c1', 1));
      expect((await store.listCycles()).map((c) => c.cycleId)).toEqual(['c2', 'c1']);
    });

    it('Run 등록: 없는 Cycle 은 no-cycle, 같은 runId 는 duplicate, 조회는 등록 순서이고 Cycle 별로 나뉜다', async () => {
      await store.createCycle(cycle('c1'));
      await store.createCycle(cycle('c2'));
      expect(await store.registerRun({ runId: 'r1', cycleId: '없음', targetId: 'android', createdAt: 'x' })).toBe('no-cycle');
      expect(await store.registerRun({ runId: 'r2', cycleId: 'c1', targetId: 'ios', createdAt: '2026-11-07T00:00:02.000Z' })).toBe('registered');
      expect(await store.registerRun({ runId: 'r1', cycleId: 'c1', targetId: 'android', createdAt: '2026-11-07T00:00:01.000Z' })).toBe('registered');
      expect(await store.registerRun({ runId: 'r1', cycleId: 'c2', targetId: 'android', createdAt: 'y' })).toBe('duplicate');
      expect(await store.registerRun({ runId: 'r3', cycleId: 'c2', targetId: 'android', createdAt: '2026-11-07T00:00:03.000Z' })).toBe('registered');
      expect((await store.runsForCycle('c1')).map((r) => [r.runId, r.targetId])).toEqual([['r2', 'ios'], ['r1', 'android']]);
      expect((await store.runsForCycle('c2')).map((r) => r.runId)).toEqual(['r3']);
      expect(await store.runsForCycle('없음')).toEqual([]);
    });

    it('돌려준 레코드를 바꿔도 저장소는 바뀌지 않는다', async () => {
      await store.createCycle(cycle('c1'));
      (await store.getCycle('c1'))!.targets.push('web');
      expect((await store.getCycle('c1'))!.targets).toEqual(['android', 'ios']);
    });
  });
}
