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

/** claim/heartbeat 계약. makeStore 가 같은 파일을 두 번 열 수 있으면(makeTwin) 두 핸들 경쟁도 본다 */
export function runClaimSuite(name: string, makeStore: () => Promise<CycleStore> | CycleStore, makeTwin?: (first: CycleStore) => Promise<CycleStore> | CycleStore): void {
  const T0 = Date.parse('2026-11-08T00:00:00.000Z');
  const TTL = 60_000;
  describe(`CycleStore 클레임 계약: ${name}`, () => {
    let store: CycleStore;
    beforeEach(async () => {
      store = await makeStore();
      await store.createCycle(cycle('c1'));
      await store.registerRun({ runId: 'r1', cycleId: 'c1', targetId: 'android', createdAt: 'x' });
      await store.registerRun({ runId: 'r2', cycleId: 'c1', targetId: 'ios', createdAt: 'x' });
      await store.registerRun({ runId: 'r3', cycleId: 'c1', targetId: 'android', createdAt: 'x' });
    });
    afterEach(async () => { await store.close?.(); });
    const noEvents = async () => false;

    it('타깃이 맞고 이벤트·lease 가 없는 Run 을 등록 순서로 하나씩 lease 와 함께 준다. 없으면 undefined', async () => {
      const a = await store.claimRun('android', 'agent-1', T0, TTL, noEvents);
      expect(a).toMatchObject({ runId: 'r1', lease: { agentId: 'agent-1', expiresAt: new Date(T0 + TTL).toISOString() } });
      const b = await store.claimRun('android', 'agent-2', T0 + 1, TTL, noEvents);
      expect(b?.runId).toBe('r3');
      expect(await store.claimRun('android', 'agent-3', T0 + 2, TTL, noEvents)).toBeUndefined();
      expect((await store.claimRun('ios', 'agent-1', T0, TTL, noEvents))?.runId).toBe('r2');
      expect((await store.runsForCycle('c1')).map((r) => r.lease?.agentId)).toEqual(['agent-1', 'agent-1', 'agent-2']);
    });

    it('이미 이벤트가 있는 Run 은 건너뛴다', async () => {
      const hasEvents = async (runId: string) => runId === 'r1';
      expect((await store.claimRun('android', 'a', T0, TTL, hasEvents))?.runId).toBe('r3');
    });

    it('만료된 lease 는 다른 에이전트가 가져가고, 만료 전에는 못 가져간다', async () => {
      await store.claimRun('ios', 'agent-1', T0, TTL, noEvents);
      expect(await store.claimRun('ios', 'agent-2', T0 + TTL - 1, TTL, noEvents)).toBeUndefined();
      const again = await store.claimRun('ios', 'agent-2', T0 + TTL, TTL, noEvents);
      expect(again).toMatchObject({ runId: 'r2', lease: { agentId: 'agent-2' } });
    });

    it('대체된(replacedBy) Run 의 heartbeat 는 소유자여도 replaced 로 거절하고 lease 를 연장하지 않는다', async () => {
      await store.claimRun('ios', 'agent-1', T0, TTL, noEvents);
      await store.registerRun({ runId: 'r2b', cycleId: 'c1', targetId: 'ios', createdAt: 'x', replaces: 'r2' });
      await store.markReplaced('r2', 'r2b', new Date(T0 + 2 * TTL).toISOString());
      expect(await store.heartbeat('r2', 'agent-1', T0 + 2 * TTL, TTL)).toEqual({ outcome: 'replaced', replacedBy: 'r2b' });
      expect((await store.runsForCycle('c1')).find((r) => r.runId === 'r2')!.lease!.expiresAt).toBe(new Date(T0 + TTL).toISOString());
    });

    it('heartbeat 는 소유자만 lease 를 연장한다', async () => {
      await store.claimRun('ios', 'agent-1', T0, TTL, noEvents);
      expect(await store.heartbeat('r2', 'agent-1', T0 + 10_000, TTL)).toEqual({ outcome: 'ok', expiresAt: new Date(T0 + 10_000 + TTL).toISOString() });
      expect(await store.heartbeat('r2', 'agent-9', T0 + 10_000, TTL)).toEqual({ outcome: 'not-owner' });
      expect(await store.heartbeat('없음', 'agent-1', T0, TTL)).toEqual({ outcome: 'no-run' });
      expect(await store.heartbeat('r1', 'agent-1', T0, TTL)).toEqual({ outcome: 'not-owner' }); // lease 없는 Run
    });

    it('대체 Run 등록(replaces)과 markReplaced: 한 번만 표시되고 두 번째는 already, 모르는 run 은 no-run', async () => {
      expect(await store.registerRun({ runId: 'r1b', cycleId: 'c1', targetId: 'android', createdAt: 'y', replaces: 'r1' })).toBe('registered');
      expect(await store.markReplaced('r1', 'r1b', '2026-11-08T00:01:00.000Z')).toBe('marked');
      expect(await store.markReplaced('r1', 'r1c', '2026-11-08T00:02:00.000Z')).toBe('already');
      expect(await store.markReplaced('없음', 'x', 'x')).toBe('no-run');
      const runs = await store.runsForCycle('c1');
      expect(runs.find((r) => r.runId === 'r1')).toMatchObject({ replacedBy: 'r1b', abandonedAt: '2026-11-08T00:01:00.000Z' });
      expect(runs.find((r) => r.runId === 'r1b')).toMatchObject({ replaces: 'r1' });
    });

    if (makeTwin) {
      it('같은 저장소를 연 두 핸들이 같은 타깃을 동시에 클레임해도 같은 Run 을 두 번 주지 않는다', async () => {
        const twin = await makeTwin(store);
        try {
          const results = await Promise.all([store.claimRun('android', 'a', T0, TTL, noEvents), twin.claimRun('android', 'b', T0, TTL, noEvents), store.claimRun('android', 'c', T0, TTL, noEvents)]);
          const ids = results.filter((r) => r !== undefined).map((r) => r!.runId).sort();
          expect(ids).toEqual(['r1', 'r3']);
        } finally { await twin.close?.(); }
      });
    }
  });
}
