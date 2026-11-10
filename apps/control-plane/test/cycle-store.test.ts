// CycleStore: 메모리·SQLite 공유 스위트 + SQLite 1→2 마이그레이션.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryCycleStore, createSqliteEventStore, createSqliteCycleStore, openSqlite, SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS } from '../src/index.ts';
import { cycleStoreSuite, runClaimSuite } from './cycle-store-suite.ts';
import { ev } from './fixtures.ts';

let dir: string;
let n = 0;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-cycle-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

cycleStoreSuite('memory', () => createMemoryCycleStore());
cycleStoreSuite('sqlite', () => createSqliteCycleStore(openSqlite(path.join(dir, `suite-${n++}.db`))));
runClaimSuite('memory', () => createMemoryCycleStore());
let lastFile = '';
runClaimSuite('sqlite', () => { lastFile = path.join(dir, `claim-${n++}.db`); return createSqliteCycleStore(openSqlite(lastFile)); }, () => createSqliteCycleStore(openSqlite(lastFile)));

describe('SQLite 마이그레이션 1→2', () => {
  it('버전 1 파일(events 만 있음)을 열면 2 로 올라가고 이벤트는 보존된다', async () => {
    const file = path.join(dir, 'v1.db');
    const raw = new DatabaseSync(file);
    raw.exec(`${SQLITE_MIGRATIONS[0]!}\nPRAGMA user_version = 1;`); // 버전 1 스키마는 첫 마이그레이션 단계 그대로
    raw.prepare('INSERT INTO events (event_id, run_id, payload) VALUES (?, ?, ?)').run('e1', 'r1', JSON.stringify(ev('e1', 'r1')));
    raw.close();

    const db = openSqlite(file);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SQLITE_SCHEMA_VERSION });
    expect(SQLITE_SCHEMA_VERSION).toBe(4);
    const events = createSqliteEventStore(db);
    const cycles = createSqliteCycleStore(db);
    expect((await events.eventsForRun('r1')).map((e) => e.eventId)).toEqual(['e1']);
    expect(await cycles.createCycle({ cycleId: 'c1', build: 'b', targets: ['android'], requiredTags: [], createdAt: 'now' })).toBe('created');
    await events.close!();
  });

  it('하나의 DB 핸들을 두 저장소가 공유하고, 재시작 뒤에도 Cycle·Run 등록이 남는다', async () => {
    const file = path.join(dir, 'cp.db');
    const a = createSqliteCycleStore(openSqlite(file));
    await a.createCycle({ cycleId: 'c1', build: 'b', targets: ['android'], requiredTags: ['smoke'], createdAt: 'now' });
    await a.registerRun({ runId: 'r1', cycleId: 'c1', targetId: 'android', createdAt: 'now' });
    await a.close!();
    const b = createSqliteCycleStore(openSqlite(file));
    expect(await b.getCycle('c1')).toMatchObject({ build: 'b', requiredTags: ['smoke'] });
    expect((await b.runsForCycle('c1')).map((r) => r.runId)).toEqual(['r1']);
    await b.close!();
  });
});
