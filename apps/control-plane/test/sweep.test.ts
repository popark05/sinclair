// sweepAbandoned: 이벤트는 있는데 끝나지 않았고 lease 만료 뒤 유예가 지난 Run → 합성 infra-failed + (한도 안) 대체 Run. 멱등.
import { describe, it, expect, beforeEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createMemoryEventStore, createMemoryCycleStore, createSqliteEventStore, createSqliteCycleStore, openSqlite, sweepAbandoned, abandonedEventId, replacementRunId, projectRun, buildCycleView, MAX_CANCEL_REPLACEMENTS, type EventStore, type CycleStore } from '../src/index.ts';
import { base, at } from './fixtures.ts';

const T0 = Date.parse(at(0)); // fixtures 와 같은 시간축
const GRACE = 60_000;
let events: EventStore; let cycles: CycleStore;
beforeEach(async () => {
  events = createMemoryEventStore(); cycles = createMemoryCycleStore();
  await cycles.createCycle({ cycleId: 'c1', build: 'b', targets: ['android', 'ios'], requiredTags: [], retryLimit: 1, createdAt: 'x' });
  await cycles.registerRun({ runId: 'r-a', cycleId: 'c1', targetId: 'android', createdAt: 'x' });
  await cycles.registerRun({ runId: 'r-i', cycleId: 'c1', targetId: 'ios', createdAt: 'x' });
});
const started = (runId: string, s: number): RunEvent[] => [
  { ...base('e0', s, runId), type: 'run.started', cycleId: 'c1', targetId: runId === 'r-a' ? 'android' : 'ios' },
  { ...base('e1', s + 1, runId), type: 'attempt.started', attemptId: `${runId}-a1`, testId: 'T', attemptNo: 1 },
];
const sweep = (nowMs: number) => sweepAbandoned(events, cycles, 'c1', { nowMs, graceMs: GRACE });
const REP1 = replacementRunId('r-a');

describe('sweepAbandoned', () => {
  it('lease 가 만료되고 유예가 지나야 버려진 것으로 본다; 끝난 run·시작 안 한 run 은 건드리지 않는다', async () => {
    await cycles.claimRun('android', 'a1', T0, GRACE, async () => false); // lease ~T0+60s
    for (const e of started('r-a', 0)) await events.append(e);
    expect(await sweep(T0 + GRACE + GRACE - 1)).toEqual({ abandoned: [], replacements: [] }); // 만료 뒤 유예 직전
    expect(await sweep(T0 + GRACE + GRACE)).toEqual({ abandoned: ['r-a'], replacements: [{ runId: REP1, replaces: 'r-a', targetId: 'android' }] });
    expect(projectRun(await events.eventsForRun('r-a')).state).toBe('infra-failed');
    const regs = await cycles.runsForCycle('c1');
    expect(regs.find((r) => r.runId === 'r-a')).toMatchObject({ replacedBy: REP1, abandonedAt: new Date(T0 + 2 * GRACE).toISOString() });
    expect(regs.find((r) => r.runId === REP1)).toMatchObject({ targetId: 'android', replaces: 'r-a' });
    expect(regs.find((r) => r.runId === 'r-i')!.replacedBy).toBeUndefined(); // 이벤트 없는 run 은 그대로
  });

  it('반복 호출은 멱등: 합성 이벤트 하나, 대체 Run 하나', async () => {
    await cycles.claimRun('android', 'a1', T0, GRACE, async () => false);
    for (const e of started('r-a', 0)) await events.append(e);
    await sweep(T0 + 2 * GRACE);
    expect(await sweep(T0 + 3 * GRACE)).toEqual({ abandoned: [], replacements: [] });
    expect((await events.eventsForRun('r-a')).filter((e) => e.eventId === abandonedEventId('r-a'))).toHaveLength(1);
    expect((await cycles.runsForCycle('c1')).filter((r) => r.replaces === 'r-a')).toHaveLength(1);
  });

  it('한도(retryLimit) 를 넘기면 infra-failed 로만 닫고 대체 Run 을 만들지 않는다; 대체 Run 자신이 버려지면 한도 안에서만 반복', async () => {
    await cycles.claimRun('android', 'a1', T0, GRACE, async () => false);
    for (const e of started('r-a', 0)) await events.append(e);
    await sweep(T0 + 2 * GRACE); // r-a → retry:r-a (사용 1/1)
    await cycles.claimRun('android', 'a2', T0 + 2 * GRACE, GRACE, async (id) => (await events.eventsForRun(id)).length > 0); // 대체 Run 클레임(r-a 는 이벤트가 있어 건너뜀)
    for (const e of started(REP1, 200)) await events.append({ ...e, runId: REP1, eventId: `${e.eventId}-rep` });
    const r = await sweep(T0 + 5 * GRACE);
    expect(r).toEqual({ abandoned: [REP1], replacements: [] });
    expect(projectRun(await events.eventsForRun(REP1)).state).toBe('infra-failed');
    expect((await cycles.runsForCycle('c1')).find((x) => x.runId === REP1)!.replacedBy).toBeUndefined();
  });

  it('lease 없이 보고되는 run(`run --run` 등)은 아무리 오래 조용해도 건드리지 않는다: 서버는 생산 시각만 알아 늦은 스풀을 죽음으로 오판할 수 있다', async () => {
    for (const e of started('r-i', 10)) await events.append(e);
    expect(await sweep(T0 + 365 * 24 * 3600_000)).toEqual({ abandoned: [], replacements: [] });
    expect(projectRun(await events.eventsForRun('r-i')).state).toBe('running');
  });

  it('등록 뒤 표시 전에 죽어도 다음 정리가 같은 대체 Run 에 표시를 마친다(결정적 id)', async () => {
    await cycles.claimRun('android', 'a1', T0, GRACE, async () => false);
    for (const e of started('r-a', 0)) await events.append(e);
    // 앞선 서버가 등록까지만 하고 죽은 상태를 재현
    await cycles.registerRun({ runId: REP1, cycleId: 'c1', targetId: 'android', createdAt: 'x', replaces: 'r-a' });
    expect(await sweep(T0 + 2 * GRACE)).toEqual({ abandoned: ['r-a'], replacements: [] });
    const regs = await cycles.runsForCycle('c1');
    expect(regs.find((r) => r.runId === 'r-a')).toMatchObject({ replacedBy: REP1 });
    expect(regs.filter((r) => r.replaces === 'r-a')).toHaveLength(1);
  });
});

// 취소된 Run(종료 신호·lease 상실로 run.finished cancelled): 계획된 종료라 유예 없이, retryLimit 을 쓰지 않고 다시 등록한다(followups 05)
describe('sweepAbandoned · 취소된 Run 재등록', () => {
  const cancelled = (runId: string, s: number): RunEvent[] => [
    ...started(runId, s).map((e) => ({ ...e, runId, eventId: `${e.eventId}-${runId}` })),
    { ...base(`fin-${runId}`, s + 2, runId), type: 'attempt.finished', attemptId: `${runId}-a1`, result: 'skipped', errorCode: 'cancelled', artifacts: [] },
    { ...base(`end-${runId}`, s + 3, runId), type: 'run.finished', state: 'cancelled' },
  ];
  const claim = (agent: string, nowMs: number) => cycles.claimRun('android', agent, nowMs, GRACE, async (id) => (await events.eventsForRun(id)).length > 0);

  it('lease 로 클레임된 Run 이 cancelled 로 끝나면 lease 가 살아 있어도 곧바로 대체 Run 을 만든다: 합성 이벤트 없음, abandonedAt 없음, replaceReason cancelled', async () => {
    await claim('a1', T0);
    for (const e of cancelled('r-a', 0)) await events.append(e);
    expect(await sweep(T0 + 1000)).toEqual({ abandoned: [], replacements: [{ runId: REP1, replaces: 'r-a', targetId: 'android', reason: 'cancelled' }] });
    expect((await events.eventsForRun('r-a')).some((e) => e.eventId === abandonedEventId('r-a'))).toBe(false);
    const regs = await cycles.runsForCycle('c1');
    const orig = regs.find((r) => r.runId === 'r-a')!;
    expect(orig.replacedBy).toBe(REP1);
    expect(orig.abandonedAt).toBeUndefined();
    expect(regs.find((r) => r.runId === REP1)).toMatchObject({ targetId: 'android', replaces: 'r-a', replaceReason: 'cancelled' });
    expect(await sweep(T0 + 2000)).toEqual({ abandoned: [], replacements: [] }); // 멱등
  });

  it('retryLimit 을 쓰지 않는다: 한도 0 이어도 다시 등록하고, 그 뒤 버려진 Run 의 대체 한도는 그대로 남는다', async () => {
    await cycles.createCycle({ cycleId: 'c0', build: 'b', targets: ['android'], requiredTags: [], retryLimit: 0, createdAt: 'x' });
    await cycles.registerRun({ runId: 'z', cycleId: 'c0', targetId: 'android', createdAt: 'x' });
    await cycles.claimRun('android', 'a1', T0, GRACE, async () => false); // r-a (c1) 를 먼저 잡는다
    const z = await cycles.claimRun('android', 'a1', T0, GRACE, async (id) => id === 'r-a');
    expect(z?.runId).toBe('z');
    for (const e of cancelled('z', 0)) await events.append(e);
    const r = await sweepAbandoned(events, cycles, 'c0', { nowMs: T0 + 1000, graceMs: GRACE });
    expect(r.replacements).toEqual([{ runId: replacementRunId('z'), replaces: 'z', targetId: 'android', reason: 'cancelled' }]);
  });

  it('취소 대체는 타깃당 MAX_CANCEL_REPLACEMENTS 까지만: 넘으면 cancelled 로 남아 blocked', async () => {
    let runId = 'r-a';
    for (let i = 0; i <= MAX_CANCEL_REPLACEMENTS; i++) {
      const claimed = await claim(`a${i}`, T0 + i * 10_000);
      expect(claimed?.runId).toBe(runId);
      for (const e of cancelled(runId, i * 10)) await events.append(e);
      const r = await sweep(T0 + i * 10_000 + 1000);
      if (i < MAX_CANCEL_REPLACEMENTS) { expect(r.replacements.map((x) => x.replaces)).toEqual([runId]); runId = replacementRunId(runId); }
      else expect(r.replacements).toEqual([]);
    }
    expect((await cycles.runsForCycle('c1')).filter((x) => x.replaceReason === 'cancelled')).toHaveLength(MAX_CANCEL_REPLACEMENTS);
  });

  it('lease 없이 보고된 Run 의 cancelled 는 그 에이전트 몫이라 건드리지 않는다', async () => {
    for (const e of cancelled('r-i', 0)) await events.append(e);
    expect(await sweep(T0 + 1000)).toEqual({ abandoned: [], replacements: [] });
  });

  it('Cycle 뷰: 취소 대체는 retriesUsed 에 세지 않고, 대체 Run 이 끝나기 전까지 Cycle 은 running(incomplete)', async () => {
    await claim('a1', T0);
    for (const e of cancelled('r-a', 0)) await events.append(e);
    await sweep(T0 + 1000);
    const v = (await buildCycleView(events, cycles, 'c1'))!;
    expect(v.retriesUsed).toEqual({ android: 0, ios: 0 });
    expect(v.verdict).toBe('incomplete');
    expect(v.runs.find((r) => r.runId === REP1)).toMatchObject({ state: 'queued', replaces: 'r-a', replaceReason: 'cancelled' });
  });
});

// 두 서버 프로세스가 같은 DB 를 보는 상황: 두 핸들이 같은 시각에 sweep 해도 합성 이벤트·대체 Run 은 하나다
describe('sweepAbandoned · SQLite 두 핸들', () => {
  it('두 핸들이 같은 Run 을 정리해도 합성 이벤트 하나, 대체 Run 하나', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sinclair-sweep-'));
    const file = path.join(dir, 'cp.db');
    const open = () => { const db = openSqlite(file); return { events: createSqliteEventStore(db), cycles: createSqliteCycleStore(db) }; };
    const a = open(); const b = open();
    await a.cycles.createCycle({ cycleId: 'c1', build: 'b', targets: ['android'], requiredTags: [], retryLimit: 1, createdAt: 'x' });
    await a.cycles.registerRun({ runId: 'r-a', cycleId: 'c1', targetId: 'android', createdAt: 'x' });
    await a.cycles.claimRun('android', 'a1', T0, GRACE, async () => false);
    for (const e of started('r-a', 0)) await a.events.append(e);
    const opts = { nowMs: T0 + 2 * GRACE, graceMs: GRACE };
    const [ra, rb] = await Promise.all([sweepAbandoned(a.events, a.cycles, 'c1', opts), sweepAbandoned(b.events, b.cycles, 'c1', opts)]);
    expect(ra.replacements.length + rb.replacements.length).toBe(1);
    expect((await a.events.eventsForRun('r-a')).filter((e) => e.eventId === abandonedEventId('r-a'))).toHaveLength(1);
    const regs = await b.cycles.runsForCycle('c1');
    expect(regs.filter((r) => r.replaces === 'r-a')).toHaveLength(1);
    expect(regs.find((r) => r.runId === 'r-a')!.replacedBy).toBe(regs.find((r) => r.replaces === 'r-a')!.runId);
    await a.events.close!(); await b.events.close!();
    await rm(dir, { recursive: true, force: true });
  });
});
