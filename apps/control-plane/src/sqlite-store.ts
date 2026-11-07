// SQLite EventStore: Node 내장 node:sqlite(네이티브 의존 없음, Node 22.13+). docs/adr/0004 참고.
// 이벤트는 event_id UNIQUE 제약으로 중복을 DB 가 막는다. 투영은 저장하지 않는다(projection.ts).
// 동기 API 라 호출마다 이벤트 루프를 잠깐 막는다: 쓰기는 Ingest 배치(본문 8 MB 상한, 보통 수백 건) 한 번에 수 ms, 읽기는 run 하나 분량이라 허용한다.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEvent } from '@sinclair/protocol';
import type { EventStore } from './store.ts';
import type { CycleRecord, CycleStore, RunRegistration } from './cycle-store.ts';

/** PRAGMA user_version. 스키마를 바꾸면 올리고 MIGRATIONS 에 단계를 더한다 */
export const SQLITE_SCHEMA_VERSION = 2;

/** MIGRATIONS[v] 는 버전 v 에서 v+1 로 가는 SQL. 순서대로 적용된다 */
const MIGRATIONS: readonly string[] = [
  // 0 → 1: 이벤트
  `CREATE TABLE events (
     seq      INTEGER PRIMARY KEY AUTOINCREMENT,   -- 저장 순서
     event_id TEXT    NOT NULL UNIQUE,
     run_id   TEXT    NOT NULL,
     payload  TEXT    NOT NULL                     -- RunEvent JSON
   );
   CREATE INDEX events_run ON events(run_id, seq);`,
  // 1 → 2: Cycle 과 Run 등록(티켓 05)
  `CREATE TABLE cycles (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 만든 순서
     cycle_id   TEXT    NOT NULL UNIQUE,
     record     TEXT    NOT NULL                   -- CycleRecord JSON
   );
   CREATE TABLE cycle_runs (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 등록 순서
     run_id     TEXT    NOT NULL UNIQUE,
     cycle_id   TEXT    NOT NULL REFERENCES cycles(cycle_id),
     record     TEXT    NOT NULL                   -- RunRegistration JSON
   );
   CREATE INDEX cycle_runs_cycle ON cycle_runs(cycle_id, seq);`,
];

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (current > SQLITE_SCHEMA_VERSION) throw new Error(`control-plane DB 스키마 버전 ${current} 은 이 빌드(${SQLITE_SCHEMA_VERSION})보다 새롭다`);
  if (current === SQLITE_SCHEMA_VERSION) return;
  if (current === 0) {
    // 버전 0 은 새 파일이어야 한다. 다른 앱의 DB 파일을 받았으면 덮어쓰지 않는다
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
    if (tables.n > 0) throw new Error('control-plane DB 가 아닌 SQLite 파일이다(스키마 버전 0 인데 테이블이 있음)');
  }
  for (let v = current; v < SQLITE_SCHEMA_VERSION; v++) {
    db.exec('BEGIN');
    db.exec(`${MIGRATIONS[v]!}\nPRAGMA user_version = ${v + 1};`);
    db.exec('COMMIT');
  }
}

/** DB 파일을 열고(없으면 만들고) 스키마를 최신으로 올린다. file 이 ':memory:' 면 프로세스 안에서만 사는 DB(테스트·실험용).
 *  EventStore 와 CycleStore 가 한 핸들을 공유한다. close 는 둘 중 어느 쪽에서 해도 되고 한 번만 닫힌다 */
export function openSqlite(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL'); // 읽기(조회)와 쓰기(ingest)가 서로 막지 않는다
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function closeOnce(db: DatabaseSync): void {
  if (db.isOpen) db.close();
}

export function createSqliteEventStore(source: string | DatabaseSync): EventStore {
  const db = typeof source === 'string' ? openSqlite(source) : source;

  const insertEvent = db.prepare('INSERT OR IGNORE INTO events (event_id, run_id, payload) VALUES (?, ?, ?)');
  const selectRun = db.prepare('SELECT payload FROM events WHERE run_id = ? ORDER BY seq');
  // run 목록은 별도 테이블 없이 이벤트에서 파생한다(INSERT 하나라 크래시에도 어긋나지 않는다)
  const selectRuns = db.prepare('SELECT run_id FROM events GROUP BY run_id ORDER BY MIN(seq)');

  return {
    async append(event) {
      const { changes } = insertEvent.run(event.eventId, event.runId, JSON.stringify(event));
      return changes === 0 ? 'duplicate' : 'accepted';
    },
    async eventsForRun(runId) {
      return (selectRun.all(runId) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as RunEvent);
    },
    async runIds() {
      return (selectRuns.all() as Array<{ run_id: string }>).map((r) => r.run_id);
    },
    async close() {
      closeOnce(db);
    },
  };
}

export function createSqliteCycleStore(source: string | DatabaseSync): CycleStore {
  const db = typeof source === 'string' ? openSqlite(source) : source;
  const insertCycle = db.prepare('INSERT OR IGNORE INTO cycles (cycle_id, record) VALUES (?, ?)');
  const selectCycle = db.prepare('SELECT record FROM cycles WHERE cycle_id = ?');
  const selectCycles = db.prepare('SELECT record FROM cycles ORDER BY seq');
  const insertRun = db.prepare('INSERT OR IGNORE INTO cycle_runs (run_id, cycle_id, record) VALUES (?, ?, ?)');
  const selectRuns = db.prepare('SELECT record FROM cycle_runs WHERE cycle_id = ? ORDER BY seq');
  const parse = <T>(rows: unknown[]): T[] => (rows as Array<{ record: string }>).map((r) => JSON.parse(r.record) as T);
  return {
    async createCycle(cycle) {
      return insertCycle.run(cycle.cycleId, JSON.stringify(cycle)).changes === 0 ? 'duplicate' : 'created';
    },
    async getCycle(cycleId) {
      const row = selectCycle.get(cycleId) as { record: string } | undefined;
      return row ? (JSON.parse(row.record) as CycleRecord) : undefined;
    },
    async listCycles() {
      return parse<CycleRecord>(selectCycles.all());
    },
    async registerRun(run) {
      if (!selectCycle.get(run.cycleId)) return 'no-cycle';
      return insertRun.run(run.runId, run.cycleId, JSON.stringify(run)).changes === 0 ? 'duplicate' : 'registered';
    },
    async runsForCycle(cycleId) {
      return parse<RunRegistration>(selectRuns.all(cycleId));
    },
    async close() {
      closeOnce(db);
    },
  };
}
