// SQLite 저장소: 공유 스위트 + 영속(재시작)·스키마 버전·DB 수준 유일 제약.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEvent } from '@sinclair/protocol';
import { createSqliteEventStore, projectRun, SQLITE_SCHEMA_VERSION } from '../src/index.ts';
import { eventStoreSuite } from './event-store-suite.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-sqlite-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

eventStoreSuite('sqlite(파일)', () => createSqliteEventStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-sqlite-suite-')), 'cp.db')));
eventStoreSuite('sqlite(:memory:)', () => createSqliteEventStore(':memory:'));

const ev = (eventId: string, s: number, type: 'run.started' | 'run.finished' = 'run.started'): RunEvent =>
  type === 'run.started'
    ? { schema: 1, eventId, runId: 'r1', at: `2026-11-07T00:00:0${s}.000Z`, type, targetId: 'android', cycleId: 'c1' }
    : { schema: 1, eventId, runId: 'r1', at: `2026-11-07T00:00:0${s}.000Z`, type, state: 'finished' };

describe('SQLite 영속', () => {
  it('닫고 같은 파일을 다시 열면 이벤트와 투영이 그대로다', async () => {
    const file = path.join(dir, 'cp.db');
    const a = createSqliteEventStore(file);
    await a.append(ev('e1', 1));
    await a.append(ev('e2', 2, 'run.finished'));
    const before = JSON.stringify(projectRun(await a.eventsForRun('r1')));
    await a.close!();

    const b = createSqliteEventStore(file);
    expect((await b.eventsForRun('r1')).map((e) => e.eventId)).toEqual(['e1', 'e2']);
    expect(JSON.stringify(projectRun(await b.eventsForRun('r1')))).toBe(before);
    expect(await b.runIds()).toEqual(['r1']);
    expect(await b.append(ev('e1', 9))).toBe('duplicate'); // 재시작 뒤에도 멱등
    await b.close!();
  });

  it('스키마 버전을 기록하고, 다른 버전의 파일은 열지 않는다', async () => {
    const file = path.join(dir, 'cp.db');
    const a = createSqliteEventStore(file);
    await a.close!();
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: SQLITE_SCHEMA_VERSION });
    raw.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => createSqliteEventStore(file)).toThrow(/스키마 버전/);
  });

  it('없는 디렉터리의 파일 경로면 디렉터리를 만든다', async () => {
    const store = createSqliteEventStore(path.join(dir, 'nested', 'deeper', 'cp.db'));
    await store.append(ev('e1', 1));
    await store.close!();
    expect(fs.existsSync(path.join(dir, 'nested', 'deeper', 'cp.db'))).toBe(true);
  });

  it('같은 eventId 를 동시에 append 해도 DB 유일 제약으로 정확히 하나만 accepted 다', async () => {
    const store = createSqliteEventStore(path.join(dir, 'cp.db'));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.append(ev('same', i % 10))));
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(19);
    expect(await store.eventsForRun('r1')).toHaveLength(1);
    await store.close!();
  });
});
