// @vitest-environment node
// HTTP 표면: POST /ingest (배치, 멱등, 부분 거부) 와 GET /runs/:id. Reporter 가 쓰는 실제 경로로 검증한다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryEventStore, serveControlPlane, projectRun, type ControlPlaneServer, type IngestResponse } from '../src/index.ts';
import { RUN, at } from './fixtures.ts';


let server: ControlPlaneServer;
beforeEach(async () => { server = await serveControlPlane(createMemoryEventStore()); });
afterEach(async () => { await server.close(); });

const post = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);

describe('POST /ingest', () => {
  it('배치를 저장하고 accepted 수를 돌려주며, 같은 배치를 다시 보내면 전부 duplicate 이고 투영은 바이트 단위로 같다', async () => {
    const first = await post(RUN);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: RUN.length, duplicate: 0, rejected: [] });
    const view1 = await (await get('/runs/r1')).text();

    const second = await post(RUN);
    expect(await second.json()).toEqual({ accepted: 0, duplicate: RUN.length, rejected: [] });
    expect(await (await get('/runs/r1')).text()).toBe(view1);
  });

  it('잘못된 원소는 index·eventId·오류와 함께 rejected 로 돌려주고 나머지는 저장된다', async () => {
    const bad = [RUN[0], { ...RUN[1], attemptNo: '1' }, { eventId: 'x' }, 'not-an-object', RUN[8]];
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
    await post([RUN[7], RUN[8], RUN[3]]);
    await post([RUN[2], RUN[0], RUN[6], RUN[1], RUN[5], RUN[4]]);
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
    expect(await (await get('/runs')).json()).toEqual([{ runId: 'r1', state: 'finished', targetId: 'android', startedAt: at(0), finishedAt: at(8), attempts: 2 }]);
  });

  it('모르는 경로는 404, GET /health 는 200', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/health')).status).toBe(200);
  });
});
