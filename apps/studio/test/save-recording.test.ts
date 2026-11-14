// @vitest-environment node
// 녹화 캐시 저장(studio 06): 세션의 녹화를 러너와 같은 키(cacheKey: 테스트 이름·mobile·시작 앱·목표·0)로 control-plane /cache 에 — 내보낸 자연어 테스트가 첫 실행부터 재생된다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startControlPlane, type RunningControlPlane } from '@sinclair/control-plane';
import { cacheKey } from '@sinclair/runner';
import { saveRecording } from '../src/worker/save-recording.ts';

let cp: RunningControlPlane;
let url: string;
beforeEach(async () => { cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused' }); url = `http://127.0.0.1:${cp.server.port}`; });
afterEach(async () => { await cp.close(); });

const recording = { actions: [{ tool: 'tap' as const, target: { role: 'button', label: '검색' }, summary: 'tap button "검색"' }], end: { anchors: [{ role: 'text', label: '검색 결과' }] } };

describe('saveRecording', () => {
  it('러너 키로 PUT, GET 하면 같은 녹화(시작 앱 전제 포함)', async () => {
    const r = await saveRecording({ controlPlane: url, testId: 'YouTube 검색', goal: 'YouTube 에서 검색', app: 'com.google.android.youtube', recording });
    const key = cacheKey({ testId: 'YouTube 검색', engine: 'mobile', app: 'com.google.android.youtube', instruction: 'YouTube 에서 검색', callIndex: 0 });
    expect(r).toEqual({ key });
    const got = await (await fetch(`${url}/cache/${key}`)).json() as { start: { app: string }; actions: unknown[]; recordedBy: { agentId: string } };
    expect(got).toMatchObject({ start: { app: 'com.google.android.youtube' }, actions: recording.actions, recordedBy: { agentId: 'studio' } });
  });

  it('control-plane 이 없거나 거부하면 사유로 던진다', async () => {
    await expect(saveRecording({ controlPlane: 'http://127.0.0.1:1', testId: 't', goal: 'g', app: '', recording })).rejects.toThrow(/control-plane/);
    await expect(saveRecording({ controlPlane: 'ftp://x', testId: 't', goal: 'g', app: '', recording })).rejects.toThrow(/http/);
  });
});
