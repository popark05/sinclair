// SQLite 저장소: 공유 스위트 + 영속(재시작)·스키마 버전·DB 수준 유일 제약.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteEventStore, projectRun, SQLITE_SCHEMA_VERSION } from '../src/index.ts';
import { eventStoreSuite } from './event-store-suite.ts';
import { ev as mk } from './fixtures.ts';

let dir: string;
let n = 0;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-sqlite-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

eventStoreSuite('sqlite(파일)', () => createSqliteEventStore(path.join(dir, `suite-${n++}.db`))); // dir 는 beforeEach 가 만들고 afterEach 가 지운다
eventStoreSuite('sqlite(:memory:)', () => createSqliteEventStore(':memory:'));

const ev = (eventId: string, s: number, type: 'run.started' | 'run.finished' = 'run.started') => mk(eventId, 'r1', type, s);

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

  it('같은 파일을 연 두 핸들이 같은 eventId 를 번갈아 append 해도 DB 유일 제약으로 정확히 하나만 accepted 다', async () => {
    // 단일 프로세스의 동기 API 라 호출은 직렬이다. 여기서 보는 것은 메모리 상태가 아니라 DB 제약이 중복을 막는다는 점이다
    const file = path.join(dir, 'cp.db');
    const a = createSqliteEventStore(file);
    const b = createSqliteEventStore(file);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append(ev('same', i % 10))));
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(19);
    expect(await a.eventsForRun('r1')).toHaveLength(1);
    expect(await b.eventsForRun('r1')).toHaveLength(1); // 다른 핸들에서도 보인다
    await a.close!(); await b.close!();
  });

  it('control-plane DB 가 아닌 SQLite 파일(버전 0 인데 테이블 있음)은 열지 않는다', () => {
    const file = path.join(dir, 'other.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE notes(id INTEGER)');
    raw.close();
    expect(() => createSqliteEventStore(file)).toThrow(/control-plane DB 가 아닌/);
  });
});
