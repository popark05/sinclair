// SQLite EventStore: Node 내장 node:sqlite(네이티브 의존 없음, Node 22.13+). docs/adr/0004 참고.
// 이벤트는 event_id UNIQUE 제약으로 중복을 DB 가 막는다. 투영은 저장하지 않는다(projection.ts).
// 동기 API 라 호출마다 이벤트 루프를 잠깐 막는다: 쓰기는 Ingest 배치(본문 8 MB 상한, 보통 수백 건) 한 번에 수 ms, 읽기는 run 하나 분량이라 허용한다.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEvent } from '@sinclair/protocol';
import type { EventStore } from './store.ts';
import { activeDeviceLeases, leaseExpired, newLease, pickDevice, type CycleRecord, type CycleStore, type RunRegistration } from './cycle-store.ts';
import { nextNodeRecord, type FleetStore, type NodeRecord } from './fleet.ts';

/** PRAGMA user_version. 스키마를 바꾸면 올리고 SQLITE_MIGRATIONS 에 단계를 더한다 */
export const SQLITE_SCHEMA_VERSION = 3;

/** MIGRATIONS[v] 는 버전 v 에서 v+1 로 가는 SQL. 순서대로 적용된다 */
export const SQLITE_MIGRATIONS: readonly string[] = [
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
  // 2 → 3: Fleet 노드 보고(device-fleet 01). 보고는 노드 단위로 통째 바뀌므로 기기를 따로 테이블로 나누지 않는다
  `CREATE TABLE fleet_nodes (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 처음 보고한 순서
     agent_id   TEXT    NOT NULL UNIQUE,
     record     TEXT    NOT NULL                   -- NodeRecord JSON
   );`,
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
    db.exec(`${SQLITE_MIGRATIONS[v]!}\nPRAGMA user_version = ${v + 1};`);
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
  const selectRun = db.prepare('SELECT record FROM cycle_runs WHERE run_id = ?');
  // 레코드가 JSON 한 덩어리라 "읽은 그대로일 때만 바꾼다"(CAS) 로 두 핸들의 동시 클레임을 막는다.
  // 비교는 저장된 텍스트 그대로이고 새 값은 parse → spread → stringify 라 키 순서가 보존된다(ADR 0004 결과 절)
  const casRun = db.prepare('UPDATE cycle_runs SET record = ? WHERE run_id = ? AND record = ?');
  const selectAllRuns = db.prepare('SELECT record FROM cycle_runs ORDER BY seq');
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
    async claimRun(targetId, agentId, nowMs, ttlMs, hasEvents, opts) {
      const all = (): RunRegistration[] => (selectAllRuns.all() as Array<{ record: string }>).map((row) => JSON.parse(row.record) as RunRegistration);
      if (pickDevice(all(), nowMs, opts) === undefined) return undefined;
      for (const row of selectAllRuns.all() as Array<{ record: string }>) {
        const r = JSON.parse(row.record) as RunRegistration;
        if (r.targetId !== targetId || !leaseExpired(r.lease, nowMs)) continue;
        if (await hasEvents(r.runId)) continue; // 비동기는 트랜잭션 밖에서
        // 빈 기기 고르기와 Run 갱신을 한 트랜잭션으로: 다른 핸들이 같은 기기를 다른 Run 에 싣는 사이에 끼어들 수 없다(BEGIN IMMEDIATE 가 쓰기 잠금을 먼저 잡는다)
        db.exec('BEGIN IMMEDIATE');
        try {
          const device = pickDevice(all(), nowMs, opts);
          if (device === undefined) { db.exec('COMMIT'); return undefined; }
          const next = { ...r, lease: newLease(agentId, nowMs, ttlMs, device ?? undefined) };
          const changed = casRun.run(JSON.stringify(next), r.runId, row.record).changes === 1; // 그 사이 바뀌었으면 다음 후보로
          db.exec('COMMIT');
          if (changed) return next;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
      return undefined;
    },
    async deviceLeases(nowMs) {
      return activeDeviceLeases((selectAllRuns.all() as Array<{ record: string }>).map((row) => JSON.parse(row.record) as RunRegistration), nowMs);
    },
    async heartbeat(runId, agentId, nowMs, ttlMs) {
      // CAS 가 계속 지면 다른 쓰기가 끼어드는 것이다(단일 프로세스에서는 거의 없음). 몇 번 뒤 not-owner 로 끝낸다
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = selectRun.get(runId) as { record: string } | undefined;
        if (!row) return { outcome: 'no-run' };
        const r = JSON.parse(row.record) as RunRegistration;
        if (r.replacedBy) return { outcome: 'replaced', replacedBy: r.replacedBy };
        if (r.lease?.agentId !== agentId) return { outcome: 'not-owner' };
        const next = { ...r, lease: newLease(agentId, nowMs, ttlMs, r.lease.deviceId) };
        if (casRun.run(JSON.stringify(next), runId, row.record).changes === 1) return { outcome: 'ok', expiresAt: next.lease.expiresAt };
      }
      return { outcome: 'not-owner' };
    },
    async markReplaced(runId, replacedBy, abandonedAt) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = selectRun.get(runId) as { record: string } | undefined;
        if (!row) return 'no-run';
        const r = JSON.parse(row.record) as RunRegistration;
        if (r.replacedBy) return 'already';
        const next = { ...r, replacedBy, abandonedAt };
        if (casRun.run(JSON.stringify(next), runId, row.record).changes === 1) return 'marked';
      }
      return 'already'; // CAS 가 계속 지면 다른 쪽이 먼저 표시한 것이다
    },
    async close() {
      closeOnce(db);
    },
  };
}

export function createSqliteFleetStore(source: string | DatabaseSync): FleetStore {
  const db = typeof source === 'string' ? openSqlite(source) : source;
  // ON CONFLICT 로 갱신하면 seq(첫 보고 순서)가 유지된다
  const upsert = db.prepare('INSERT INTO fleet_nodes (agent_id, record) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET record = excluded.record');
  const selectOne = db.prepare('SELECT record FROM fleet_nodes WHERE agent_id = ?');
  const selectAll = db.prepare('SELECT record FROM fleet_nodes ORDER BY seq');
  return {
    async reportNode(agentId, report, nowMs) {
      // 이전 기록을 읽고 쓰는 사이가 끊기지 않게 한 트랜잭션으로(같은 노드는 한 데몬만 보고하지만 두 서버가 한 파일을 볼 수 있다)
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = selectOne.get(agentId) as { record: string } | undefined;
        const prev = row ? (JSON.parse(row.record) as NodeRecord) : undefined;
        upsert.run(agentId, JSON.stringify(nextNodeRecord(prev && { ...prev, missing: prev.missing ?? [] }, agentId, report, nowMs)));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async listNodes() {
      return (selectAll.all() as Array<{ record: string }>).map((r) => { const n = JSON.parse(r.record) as NodeRecord; return { ...n, missing: n.missing ?? [] }; });
    },
    async close() {
      closeOnce(db);
    },
  };
}
