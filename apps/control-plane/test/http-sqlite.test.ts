// @vitest-environment node
// SQLite 저장소로 띄운 서버가 재시작 뒤에도 같은 Run 을 돌려준다(HTTP 경로).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEvent } from '@sinclair/protocol';
import { createSqliteEventStore, serveControlPlane } from '../src/index.ts';

const base = (eventId: string, s: number) => ({ schema: 1 as const, eventId, runId: 'r1', at: `2026-11-07T00:00:0${s}.000Z` });
const RUN: RunEvent[] = [
  { ...base('e0', 0), type: 'run.started', targetId: 'android' },
  { ...base('e1', 1), type: 'attempt.started', attemptId: 'a1', testId: '로그인', attemptNo: 1 },
  { ...base('e2', 2), type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [] },
  { ...base('e3', 3), type: 'run.finished', state: 'finished' },
];

describe('serveControlPlane + SQLite', () => {
  it('서버를 내렸다 같은 DB 파일로 다시 올려도 GET /runs/:id 가 같고 재전송은 duplicate 다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-cp-'));
    const file = path.join(dir, 'cp.db');
    try {
      const store1 = createSqliteEventStore(file);
      const s1 = await serveControlPlane(store1);
      await fetch(`http://127.0.0.1:${s1.port}/ingest`, { method: 'POST', body: JSON.stringify(RUN) });
      const view1 = await (await fetch(`http://127.0.0.1:${s1.port}/runs/r1`)).text();
      await s1.close(); await store1.close!();

      const store2 = createSqliteEventStore(file);
      const s2 = await serveControlPlane(store2);
      expect(await (await fetch(`http://127.0.0.1:${s2.port}/runs/r1`)).text()).toBe(view1);
      const again = await (await fetch(`http://127.0.0.1:${s2.port}/ingest`, { method: 'POST', body: JSON.stringify(RUN) })).json();
      expect(again).toEqual({ accepted: 0, duplicate: 4, rejected: [] });
      await s2.close(); await store2.close!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
