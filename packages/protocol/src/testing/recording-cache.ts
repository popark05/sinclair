// 녹화 캐시 저장소 계약 스위트와 메모리 구현(테스트·단일 프로세스용). 구현체(파일·control-plane·HTTP)는 이 스위트를 통과해야 한다.
import { describe, it, expect } from 'vitest';
import { assertCacheKey, parseCacheEntry, CACHE_SCHEMA, type CacheEntry, type CacheStore } from '../recording-cache.ts';

export const SAMPLE_CACHE_ENTRY: CacheEntry = {
  schema: CACHE_SCHEMA, createdAt: '2026-11-14T00:00:00.000Z', recordedBy: { model: 'claude-sonnet-5-5' },
  start: { app: 'com.example.app' },
  actions: [
    { tool: 'tap', target: { role: 'button', label: '검색', testId: 'com.example.app:id/search' }, summary: 'tap button "검색"' },
    { tool: 'type', target: { role: 'textbox', placeholder: '검색어' }, text: '{{secret:QA_SEARCH}}', summary: 'type textbox' },
    { tool: 'submit', target: { role: 'textbox', placeholder: '검색어' }, summary: 'submit textbox' },
    { tool: 'scroll', target: { role: 'list' }, direction: 'down', summary: 'scroll list down' },
    { tool: 'back', summary: 'back' },
  ],
  end: { anchors: [{ role: 'text', label: '검색 결과' }] },
};

export interface MemoryCacheStore extends CacheStore { size(): number }

export function createMemoryCacheStore(): MemoryCacheStore {
  const entries = new Map<string, string>();
  return {
    async read(key) {
      assertCacheKey(key);
      const raw = entries.get(key);
      if (raw === undefined) return undefined;
      const parsed = parseCacheEntry(JSON.parse(raw));
      return parsed.ok ? parsed.value : undefined;
    },
    async write(key, entry) {
      assertCacheKey(key);
      const parsed = parseCacheEntry(entry);
      if (!parsed.ok) throw new Error(`녹화 캐시 항목이 계약을 통과하지 못함: ${parsed.errors.join('; ')}`);
      entries.set(key, JSON.stringify(entry));
    },
    async delete(key) { assertCacheKey(key); entries.delete(key); },
    size: () => entries.size,
  };
}

export function cacheStoreContractSuite(name: string, make: () => CacheStore | Promise<CacheStore>, sample: CacheEntry = SAMPLE_CACHE_ENTRY): void {
  describe(`CacheStore 계약: ${name}`, () => {
    const K1 = '1'.repeat(64), K2 = '2'.repeat(64);
    it('쓴 항목을 같은 키로 읽고(사본 — 고쳐도 저장된 것은 그대로), 없는 키는 undefined, 지우면 다시 undefined', async () => {
      const s = await make();
      expect(await s.read(K1)).toBeUndefined();
      await s.write(K1, structuredClone(sample));
      const got = await s.read(K1);
      expect(got).toEqual(sample);
      got!.actions.length = 0;
      expect(await s.read(K1)).toEqual(sample);
      expect(await s.read(K2)).toBeUndefined();
      await s.delete(K1);
      expect(await s.read(K1)).toBeUndefined();
      await s.delete(K1); // 없는 키 지우기는 오류가 아니다
    });
    it('같은 키에 다시 쓰면 덮어쓴다', async () => {
      const s = await make();
      await s.write(K1, sample);
      const next = { ...structuredClone(sample), createdAt: '2026-11-15T00:00:00.000Z' };
      await s.write(K1, next);
      expect((await s.read(K1))!.createdAt).toBe(next.createdAt);
    });
    it('키 모양이 틀리면(경로 탈출 등) 읽기·쓰기·지우기 모두 던진다', async () => {
      const s = await make();
      for (const bad of ['../x', 'A'.repeat(64), '']) {
        await expect(s.read(bad)).rejects.toThrow(/키/);
        await expect(s.write(bad, sample)).rejects.toThrow(/키/);
        await expect(s.delete(bad)).rejects.toThrow(/키/);
      }
    });
    it('계약을 통과하지 못하는 항목은 쓰지 않는다', async () => {
      const s = await make();
      await expect(s.write(K1, { ...sample, schema: 'rc-0' } as never)).rejects.toThrow(/계약/);
      expect(await s.read(K1)).toBeUndefined();
    });
  });
}
