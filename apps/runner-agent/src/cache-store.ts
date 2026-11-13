// 녹화 캐시 HTTP 저장소(recording-cache 05): control-plane 의 /cache/:key. 노드 하나가 녹화하면 플릿 전체가 재생한다.
// 실패(5xx·연결 실패)는 던진다 — 러너가 읽기 실패는 미스, 쓰기 실패는 경고로 다뤄 테스트 결과를 바꾸지 않는다.
import { assertCacheKey, parseCacheEntry, type CacheStore } from '@sinclair/protocol';

export function createHttpCacheStore(controlPlane: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): CacheStore {
  const urlOf = (key: string): string => { assertCacheKey(key); return `${controlPlane.replace(/\/+$/, '')}/cache/${key}`; };
  const fail = async (what: string, res: Response): Promise<never> => {
    const body = await res.text().catch(() => '');
    throw new Error(`녹화 캐시 ${what} 실패: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
  };
  return {
    async read(key) {
      const res = await fetchImpl(urlOf(key));
      if (res.status === 404) return undefined;
      if (!res.ok) return fail('읽기', res);
      const parsed = parseCacheEntry(await res.json());
      return parsed.ok ? parsed.value : undefined;
    },
    async write(key, entry) {
      const url = urlOf(key);
      const parsed = parseCacheEntry(entry);
      if (!parsed.ok) throw new Error(`녹화 캐시 항목이 계약을 통과하지 못함: ${parsed.errors.join('; ')}`);
      const res = await fetchImpl(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
      if (!res.ok) await fail('쓰기', res);
    },
    async delete(key) {
      const res = await fetchImpl(urlOf(key), { method: 'DELETE' });
      if (!res.ok) await fail('지우기', res);
    },
  };
}
