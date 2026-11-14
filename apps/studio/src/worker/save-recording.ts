// 녹화 캐시 저장(studio 06): 세션 녹화를 러너와 같은 키(cacheKey: 테스트 이름·mobile·시작 앱·목표·반복 0)로 control-plane /cache 에 쓴다.
// 그러면 내보낸 자연어 테스트(`agent.act(목표)`)가 첫 실행부터 모델 없이 재생된다.
import { CACHE_SCHEMA, parseCacheEntry, type CacheAction, type CacheEntry, type CacheTarget } from '@sinclair/protocol';
import { cacheKey } from '@sinclair/runner';

export interface SaveRecordingInput { controlPlane: string; testId: string; goal: string; app: string; recording: { actions: CacheAction[]; end: { anchors: CacheTarget[] } } }

export async function saveRecording(input: SaveRecordingInput, doFetch: typeof fetch = fetch): Promise<{ key: string }> {
  let base: URL;
  try { base = new URL(input.controlPlane); } catch { throw new Error(`control-plane 주소가 아님: ${input.controlPlane}`); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`control-plane 주소는 http(s) 여야 함: ${input.controlPlane}`);
  const entry: CacheEntry = { schema: CACHE_SCHEMA, createdAt: new Date().toISOString(), recordedBy: { agentId: 'studio' }, start: input.app ? { app: input.app } : {}, actions: input.recording.actions, end: input.recording.end };
  const parsed = parseCacheEntry(entry);
  if (!parsed.ok) throw new Error(`녹화가 계약을 통과하지 못함: ${parsed.errors.join('; ')}`);
  // 엔진 이름 'mobile' — 내보낸 테스트를 도는 runner-agent 의 엔진(createMobileEngine)과 같아야 키가 맞는다
  const key = cacheKey({ testId: input.testId, engine: 'mobile', app: input.app, instruction: input.goal, callIndex: 0 });
  let res: Response;
  try {
    res = await doFetch(`${input.controlPlane.replace(/\/+$/, '')}/cache/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
  } catch (err) { throw new Error(`control-plane 에 닿지 않음(${input.controlPlane}): ${err instanceof Error ? err.message : String(err)}`); }
  if (!res.ok) throw new Error(`control-plane 이 녹화를 받지 않음: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { key };
}
