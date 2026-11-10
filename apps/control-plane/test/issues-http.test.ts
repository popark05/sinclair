// @vitest-environment node
// Issue: 실패를 서명(errorCode + 정규화한 실패 스텝 지시)으로 자동으로 묶고, 사람이 분류(제품·테스트·인프라·불안정)·메모·티켓 링크를 단다(저장).
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEvent } from '@sinclair/protocol';
import { createMemoryEventStore, serveControlPlane, createSqliteIssueStore, issueSignature, type ControlPlaneServer, type IssueView } from '../src/index.ts';

let server: ControlPlaneServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const url = (p: string) => `http://127.0.0.1:${server!.port}${p}`;
const post = (p: string, body: unknown, method = 'POST') => fetch(url(p), { method, body: JSON.stringify(body) });
let n = 0;
const ev = (runId: string, e: Record<string, unknown>): RunEvent => ({ schema: 1, eventId: `i${++n}`, runId, at: new Date(Date.UTC(2026, 10, 10, 0, 0, n)).toISOString(), ...e }) as RunEvent;
/** 실패 하나: 실패 스텝 지시와 errorCode */
function failing(runId: string, cycleId: string, tests: Array<{ testId: string; instruction?: string; errorCode: string; result?: string }>): RunEvent[] {
  const out = [ev(runId, { type: 'run.started', cycleId, targetId: 'android' })];
  for (const t of tests) {
    const attemptId = `${runId}-${t.testId}`;
    out.push(ev(runId, { type: 'attempt.started', attemptId, testId: t.testId, attemptNo: 1 }));
    if (t.instruction) out.push(ev(runId, { type: 'step.recorded', attemptId, stepIndex: 0, kind: 'locator', instruction: t.instruction, modelCalls: 0, durationMs: 300 }));
    out.push(ev(runId, { type: 'attempt.finished', attemptId, result: t.result ?? 'failed', errorCode: t.errorCode, artifacts: [] }));
  }
  out.push(ev(runId, { type: 'run.finished', state: 'finished' }));
  return out;
}
const miss = (ms: number, ref: string) => `tap { text="결제" } → 실패: { text="결제" } 에 맞는 노드가 없음 (${ms}ms 기다림). 마지막 화면의 관련 노드: ${ref} root; @e9 button`;

describe('issueSignature', () => {
  it('숫자·ref·기다린 시간·마지막 화면 요약을 빼고 errorCode 와 실패 지시로', () => {
    expect(issueSignature('not-found', miss(301, '@e0'))).toEqual(issueSignature('not-found', miss(5002, '@e17')));
    expect(issueSignature('not-found', miss(301, '@e0'))).not.toEqual(issueSignature('assertion', miss(301, '@e0')));
    expect(issueSignature('not-found', miss(301, '@e0')).summary).toBe('tap { text="결제" } → 실패: { text="결제" } 에 맞는 노드가 없음');
  });
});

describe('GET /issues · PUT /issues/:id', () => {
  it('최근 Cycle 들의 실패를 서명으로 묶고(테스트·발생 수), 인프라 코드는 추천 분류; 사람이 분류·메모·티켓을 단다', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    for (const [i, ms] of [[0, 301], [1, 5002]] as const) {
      await post('/cycles', { cycleId: `c${i}`, build: `1.${i}`, targets: ['android'] });
      await post(`/cycles/c${i}/runs`, { targetId: 'android', runId: `r${i}` });
      await post('/ingest', failing(`r${i}`, `c${i}`, [
        { testId: '결제', instruction: miss(ms, `@e${i}`), errorCode: 'not-found' },
        { testId: '장바구니 결제', instruction: miss(ms + 7, '@e3'), errorCode: 'not-found' },
        { testId: '로그인', errorCode: 'device-unavailable', result: 'blocked' },
      ]));
    }
    const list = (await (await fetch(url('/issues'))).json()) as IssueView[];
    expect(list).toHaveLength(2);
    const pay = list[0]!;
    expect(pay).toMatchObject({ errorCode: 'not-found', count: 4, tests: ['결제', '장바구니 결제'], summary: expect.stringMatching(/결제.*노드가 없음/) });
    expect(pay.occurrences.map((o) => o.cycleId)).toEqual(['c1', 'c1', 'c0', 'c0']); // 최신 먼저
    expect(pay).not.toHaveProperty('category');
    expect(list[1]).toMatchObject({ errorCode: 'device-unavailable', suggested: 'infra', count: 2 });

    expect((await post(`/issues/${pay.id}`, { category: 'product', note: '결제 버튼 사라짐', ticketUrl: 'https://jira.example.com/QA-1' }, 'PUT')).status).toBe(200);
    expect((await (await fetch(url('/issues'))).json() as IssueView[])[0]).toMatchObject({ id: pay.id, category: 'product', note: '결제 버튼 사라짐', ticketUrl: 'https://jira.example.com/QA-1' });
    for (const bad of [{ category: 'bug' }, { category: 'product', ticketUrl: 'javascript:alert(1)' }, { category: 'product', note: 'x'.repeat(2001) }]) expect((await post(`/issues/${pay.id}`, bad, 'PUT')).status).toBe(400);
    expect((await post('/issues/not-an-id', { category: 'product' }, 'PUT')).status).toBe(400);
    // 분류를 지우면(null) 다시 미분류
    await post(`/issues/${pay.id}`, { category: null }, 'PUT');
    expect((await (await fetch(url('/issues'))).json() as IssueView[])[0]).not.toHaveProperty('category');
  });

  it('SQLite 저장소면 분류가 서버 재시작 뒤에도 남는다', async () => {
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-issues-')), 'cp.db');
    const s1 = createSqliteIssueStore(db);
    await s1.set('abcdef012345', { category: 'flaky', note: 'n' });
    const s2 = createSqliteIssueStore(db);
    expect(await s2.get('abcdef012345')).toMatchObject({ category: 'flaky', note: 'n' });
  });
});
