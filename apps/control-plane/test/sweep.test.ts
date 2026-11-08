// sweepAbandoned: 이벤트는 있는데 끝나지 않았고 lease 만료 뒤 유예가 지난 Run → 합성 infra-failed + (한도 안) 대체 Run. 멱등.
import { describe, it, expect, beforeEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createMemoryEventStore, createMemoryCycleStore, createSqliteEventStore, createSqliteCycleStore, openSqlite, sweepAbandoned, abandonedEventId, projectRun, type EventStore, type CycleStore } from '../src/index.ts';
import { base, at } from './fixtures.ts';

const T0 = Date.parse(at(0)); // fixtures 와 같은 시간축
const GRACE = 60_000;
let events: EventStore; let cycles: CycleStore; let ids: string[];
beforeEach(async () => {
  events = createMemoryEventStore(); cycles = createMemoryCycleStore(); ids = ['rep-1', 'rep-2', 'rep-3'];
  await cycles.createCycle({ cycleId: 'c1', build: 'b', targets: ['android', 'ios'], requiredTags: [], retryLimit: 1, createdAt: 'x' });
  await cycles.registerRun({ runId: 'r-a', cycleId: 'c1', targetId: 'android', createdAt: 'x' });
  await cycles.registerRun({ runId: 'r-i', cycleId: 'c1', targetId: 'ios', createdAt: 'x' });
});
const started = (runId: string, s: number): RunEvent[] => [
  { ...base('e0', s, runId), type: 'run.started', cycleId: 'c1', targetId: runId === 'r-a' ? 'android' : 'ios' },
  { ...base('e1', s + 1, runId), type: 'attempt.started', attemptId: `${runId}-a1`, testId: 'T', attemptNo: 1 },
];
const sweep = (nowMs: number) => sweepAbandoned(events, cycles, 'c1', { nowMs, graceMs: GRACE, newRunId: () => ids.shift()! });

describe('sweepAbandoned', () => {
  it('lease 가 만료되고 유예가 지나야 버려진 것으로 본다; 끝난 run·시작 안 한 run 은 건드리지 않는다', async () => {
    await cycles.claimRun('android', 'a1', T0, GRACE, async () => false); // lease ~T0+60s
    for (const e of started('r-a', 0)) await events.append(e);
    expect(await sweep(T0 + GRACE + GRACE - 1)).toEqual({ abandoned: [], replacements: [] }); // 만료 뒤 유예 직전
    expect(await sweep(T0 + GRACE + GRACE)).toEqual({ abandoned: ['r-a'], replacements: [{ runId: 'rep-1', replaces: 'r-a', targetId: 'android' }] });
    expect(projectRun(await events.eventsForRun('r-a')).state).toBe('infra-failed');
    const regs = await cycles.runsForCycle('c1');
    expect(regs.find((r) => r.runId === 'r-a')).toMatchObject({ replacedBy: 'rep-1' });
    expect(regs.find((r) => r.runId === 'rep-1')).toMatchObject({ targetId: 'android', replaces: 'r-a' });
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
    await sweep(T0 + 2 * GRACE); // r-a → rep-1 (사용 1/1)
    await cycles.claimRun('android', 'a2', T0 + 2 * GRACE, GRACE, async () => false); // rep-1 클레임
    for (const e of started('rep-1', 200)) await events.append({ ...e, runId: 'rep-1', eventId: `${e.eventId}-rep` });
    const r = await sweep(T0 + 5 * GRACE);
    expect(r).toEqual({ abandoned: ['rep-1'], replacements: [] });
    expect(projectRun(await events.eventsForRun('rep-1')).state).toBe('infra-failed');
    expect((await cycles.runsForCycle('c1')).find((x) => x.runId === 'rep-1')!.replacedBy).toBeUndefined();
  });

  it('lease 없이 시작한 run(`run --run` 오프라인 등)은 마지막 이벤트 시각 기준으로 버려짐을 판정한다', async () => {
    for (const e of started('r-i', 10)) await events.append(e); // 마지막 이벤트 T0+11s
    expect((await sweep(T0 + 11_000 + GRACE - 1)).abandoned).toEqual([]);
    expect((await sweep(T0 + 11_000 + GRACE)).abandoned).toEqual(['r-i']);
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
    const opts = (id: string) => ({ nowMs: T0 + 2 * GRACE, graceMs: GRACE, newRunId: () => id });
    const [ra, rb] = await Promise.all([sweepAbandoned(a.events, a.cycles, 'c1', opts('rep-a')), sweepAbandoned(b.events, b.cycles, 'c1', opts('rep-b'))]);
    expect(ra.replacements.length + rb.replacements.length).toBe(1);
    expect((await a.events.eventsForRun('r-a')).filter((e) => e.eventId === abandonedEventId('r-a'))).toHaveLength(1);
    const regs = await b.cycles.runsForCycle('c1');
    expect(regs.filter((r) => r.replaces === 'r-a')).toHaveLength(1);
    expect(regs.find((r) => r.runId === 'r-a')!.replacedBy).toBe(regs.find((r) => r.replaces === 'r-a')!.runId);
    await a.events.close!(); await b.events.close!();
    await rm(dir, { recursive: true, force: true });
  });
});
