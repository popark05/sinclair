// @vitest-environment node
// Console → Studio(studio-console 06): 작업 프로세스가 control-plane 에서 연결된 기기들의 열기 요청을 가져오고 처리하면 ack.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startControlPlane, type RunningControlPlane } from '@sinclair/control-plane';
import { fetchOpenRequests, ackOpenRequest } from '../src/worker/open-requests.ts';

let cp: RunningControlPlane;
let url: string;
beforeEach(async () => { cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused' }); url = `http://127.0.0.1:${cp.server.port}`; });
afterEach(async () => { await cp.close(); });

describe('열기 요청', () => {
  it('연결된 기기의 요청만 가져오고 ack 하면 다시 오지 않는다', async () => {
    await fetch(`${url}/studio/open-requests`, { method: 'POST', body: JSON.stringify({ deviceId: 'D1', goal: '로그인', from: { testId: 'T' } }) });
    await fetch(`${url}/studio/open-requests`, { method: 'POST', body: JSON.stringify({ deviceId: 'OTHER' }) });
    const got = await fetchOpenRequests({ controlPlane: url, devices: ['D1'] });
    expect(got).toEqual([expect.objectContaining({ deviceId: 'D1', goal: '로그인', from: { testId: 'T' } })]);
    await ackOpenRequest({ controlPlane: url, id: got[0]!.id });
    expect(await fetchOpenRequests({ controlPlane: url, devices: ['D1'] })).toEqual([]);
    expect(await fetchOpenRequests({ controlPlane: url, devices: [] })).toEqual([]); // 기기가 없으면 묻지 않는다
  });
});
