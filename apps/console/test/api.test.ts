// Console 의 control-plane API 클라이언트: 응답을 타입으로, HTTP 오류·연결 실패는 화면에 보일 분명한 오류로.
import { describe, it, expect } from 'vitest';
import { createApi, ApiError } from '../src/api.ts';

const respond = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createApi', () => {
  it('Cycle 요약·Cycle·Run·Fleet 을 그 경로로 가져온다', async () => {
    const seen: string[] = [];
    const api = createApi('/api', async (input) => { seen.push(String(input)); return new Response('[]', { status: 200 }); });
    await api.cycleSummaries(20);
    await api.cycle('c 1');
    await api.run('r/1');
    await api.fleet();
    expect(seen).toEqual(['/api/cycles/summary?limit=20', '/api/cycles/c%201', '/api/runs/r%2F1', '/api/fleet']);
  });

  it('HTTP 오류는 서버의 error 문구와 상태를 담은 ApiError', async () => {
    const err = await createApi('', respond(404, { error: '모르는 Cycle' })).cycle('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: expect.stringMatching(/모르는 Cycle/) });
  });

  it('연결 실패는 control-plane 에 닿지 않는다는 ApiError(상태 없음)', async () => {
    const err = await createApi('', async () => { throw new TypeError('fetch failed'); }).fleet().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: undefined, message: expect.stringMatching(/control-plane 에 닿지 않음/) });
  });
});
