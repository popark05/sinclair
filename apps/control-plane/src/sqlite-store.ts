// SQLite EventStore: Node 내장 node:sqlite(동기 API, 네이티브 의존 없음). docs/adr/0004 참고.
// 이벤트는 eventId 를 PRIMARY KEY 로 저장해 중복을 DB 제약이 막는다. 투영은 저장하지 않는다(projection.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEvent } from '@sinclair/protocol';
import type { EventStore } from './store.ts';

/** PRAGMA user_version. 스키마를 바꾸면 올리고 migrate() 에 단계를 더한다 */
export const SQLITE_SCHEMA_VERSION = 1;

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (current > SQLITE_SCHEMA_VERSION) throw new Error(`control-plane DB 스키마 버전 ${current} 은 이 빌드(${SQLITE_SCHEMA_VERSION})보다 새롭다`);
  if (current === SQLITE_SCHEMA_VERSION) return;
  if (current !== 0) throw new Error(`control-plane DB 스키마 버전 ${current} 에서 ${SQLITE_SCHEMA_VERSION} 로 가는 마이그레이션이 없다`);
  db.exec(`
    CREATE TABLE events (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,   -- 저장 순서
      event_id TEXT    NOT NULL UNIQUE,
      run_id   TEXT    NOT NULL,
      payload  TEXT    NOT NULL                     -- RunEvent JSON
    );
    CREATE INDEX events_run ON events(run_id, seq);
    CREATE TABLE runs (
      run_id     TEXT    PRIMARY KEY,
      first_seen INTEGER NOT NULL                   -- 처음 본 순서(events.seq)
    );
    PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
  `);
}

export function createSqliteEventStore(file: string): EventStore {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL'); // 읽기(조회)와 쓰기(ingest)가 서로 막지 않는다
  migrate(db);

  const insertEvent = db.prepare('INSERT OR IGNORE INTO events (event_id, run_id, payload) VALUES (?, ?, ?)');
  const insertRun = db.prepare('INSERT OR IGNORE INTO runs (run_id, first_seen) VALUES (?, ?)');
  const selectRun = db.prepare('SELECT payload FROM events WHERE run_id = ? ORDER BY seq');
  const selectRuns = db.prepare('SELECT run_id FROM runs ORDER BY first_seen');

  return {
    async append(event) {
      const { changes, lastInsertRowid } = insertEvent.run(event.eventId, event.runId, JSON.stringify(event));
      if (changes === 0) return 'duplicate';
      insertRun.run(event.runId, Number(lastInsertRowid));
      return 'accepted';
    },
    async eventsForRun(runId) {
      return (selectRun.all(runId) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as RunEvent);
    },
    async runIds() {
      return (selectRuns.all() as Array<{ run_id: string }>).map((r) => r.run_id);
    },
    async close() {
      db.close();
    },
  };
}
