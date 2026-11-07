// @vitest-environment node
// HTTP 표면: POST /ingest (배치, 멱등, 부분 거부) 와 GET /runs/:id. Reporter 가 쓰는 실제 경로로 검증한다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RunEvent } from '@sinclair/protocol';
import { createMemoryEventStore, serveControlPlane, projectRun, type ControlPlaneServer, type IngestResponse } from '../src/index.ts';

const at = (s: number) => `2026-11-07T00:00:${String(s).padStart(2, '0')}.000Z`;
const base = (eventId: string, s: number) => ({ schema: 1 as const, eventId, runId: 'r1', at: at(s) });
const RUN: RunEvent[] = [
  { ...base('e0', 0), type: 'run.started', targetId: 'android' },
  { ...base('e1', 1), type: 'attempt.started', attemptId: 'a1', testId: '로그인', attemptNo: 1 },
  { ...base('e2', 2), type: 'step.recorded', attemptId: 'a1', stepIndex: 0, kind: 'assert', modelCalls: 0, durationMs: 5 },
  { ...base('e3', 3), type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [] },
  { ...base('e4', 4), type: 'run.finished', state: 'finished' },
];

let server: ControlPlaneServer;
beforeEach(async () => { server = await serveControlPlane(createMemoryEventStore()); });
afterEach(async () => { await server.close(); });

const post = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);

describe('POST /ingest', () => {
  it('배치를 저장하고 accepted 수를 돌려주며, 같은 배치를 다시 보내면 전부 duplicate 이고 투영은 바이트 단위로 같다', async () => {
    const first = await post(RUN);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: 5, duplicate: 0, rejected: [] });
    const view1 = await (await get('/runs/r1')).text();

    const second = await post(RUN);
    expect(await second.json()).toEqual({ accepted: 0, duplicate: 5, rejected: [] });
    expect(await (await get('/runs/r1')).text()).toBe(view1);
  });

  it('잘못된 원소는 index·eventId·오류와 함께 rejected 로 돌려주고 나머지는 저장된다', async () => {
    const bad = [RUN[0], { ...RUN[1], attemptNo: '1' }, { eventId: 'x' }, 'not-an-object', RUN[4]];
    const res = await post(bad);
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestResponse;
    expect(body.accepted).toBe(2);
    expect(body.rejected).toEqual([
      { index: 1, eventId: 'e1', errors: [expect.stringMatching(/attemptNo/)] },
      { index: 2, eventId: 'x', errors: expect.arrayContaining([expect.stringMatching(/type/)]) },
      { index: 3, errors: [expect.stringMatching(/객체/)] },
    ]);
    const view = await (await get('/runs/r1')).json();
    expect(view).toMatchObject({ state: 'finished', attempts: [] });
  });

  it('본문이 JSON 배열이 아니면 400', async () => {
    expect((await post('{')).status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post([])).status).toBe(200);
    expect(await (await post([])).json()).toEqual({ accepted: 0, duplicate: 0, rejected: [] });
  });

  it('본문이 상한을 넘으면 413', async () => {
    await server.close();
    server = await serveControlPlane(createMemoryEventStore(), { maxBodyBytes: 100 });
    expect((await post(RUN)).status).toBe(413);
    expect((await post([])).status).toBe(200);
  });

  it('순서가 뒤섞인 두 배치로 나눠 보내도 투영이 같다', async () => {
    await post([RUN[3], RUN[4]]);
    await post([RUN[2], RUN[0], RUN[1]]);
    expect(await (await get('/runs/r1')).json()).toEqual(projectRun(RUN));
  });
});

describe('GET /runs', () => {
  it('모르는 run 은 404, 저장된 run 은 투영을 돌려준다', async () => {
    expect((await get('/runs/없음')).status).toBe(404);
    await post(RUN.slice(0, 2));
    const res = await get('/runs/r1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId: 'r1', state: 'running', attempts: [{ attemptId: 'a1', testId: '로그인' }] });
  });

  it('GET /runs 는 run 목록을 요약으로 돌려준다', async () => {
    await post(RUN);
    expect(await (await get('/runs')).json()).toEqual([{ runId: 'r1', state: 'finished', targetId: 'android', startedAt: at(0), finishedAt: at(4), attempts: 1 }]);
  });

  it('모르는 경로는 404, GET /health 는 200', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/health')).status).toBe(200);
  });
});
