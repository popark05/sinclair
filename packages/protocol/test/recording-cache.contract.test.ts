// 녹화 캐시 계약: 항목 모양(닫힌 검증기)과 저장소 계약 스위트. 러너(기록·재생)와 control-plane(공유 저장)이 같은 계약을 쓴다.
import { describe, it, expect } from 'vitest';
import { parseCacheEntry, CACHE_KEY, CACHE_LIMITS } from '../src/index.ts';
import { cacheStoreContractSuite, createMemoryCacheStore, SAMPLE_CACHE_ENTRY as SAMPLE_ENTRY } from '../src/testing/index.ts';


describe('parseCacheEntry', () => {
  it('올바른 항목은 그대로 통과한다', () => {
    expect(parseCacheEntry(structuredClone(SAMPLE_ENTRY))).toEqual({ ok: true, value: SAMPLE_ENTRY });
  });

  it('닫힌 검사: 모르는 필드·모르는 툴·대상 없는 tap·글자 없는 type·방향 틀린 scroll·스키마 다름을 거부한다', () => {
    const bad = (patch: (e: Record<string, unknown> & { actions: Array<Record<string, unknown>> }) => void): string[] => {
      const e = structuredClone(SAMPLE_ENTRY) as unknown as Record<string, unknown> & { actions: Array<Record<string, unknown>> };
      patch(e);
      const r = parseCacheEntry(e);
      return r.ok ? [] : r.errors;
    };
    expect(bad((e) => { e.extra = 1; })).toEqual([expect.stringMatching(/extra/)]);
    expect(bad((e) => { e.schema = 'rc-0'; })).toEqual([expect.stringMatching(/schema/)]);
    expect(bad((e) => { e.actions[0]!.tool = 'done'; })).toEqual([expect.stringMatching(/actions\[0\]\.tool/)]);
    expect(bad((e) => { delete e.actions[0]!.target; })).toEqual([expect.stringMatching(/actions\[0\]\.target/)]);
    expect(bad((e) => { delete e.actions[1]!.text; })).toEqual([expect.stringMatching(/actions\[1\]\.text/)]);
    expect(bad((e) => { e.actions[3]!.direction = 'left'; })).toEqual([expect.stringMatching(/actions\[3\]\.direction/)]);
    expect(bad((e) => { (e.actions[0]!.target as Record<string, unknown>).ref = '@e1'; })).toEqual([expect.stringMatching(/target\.ref/)]); // ref 는 화면마다 바뀐다: 기록하지 않는다
    expect(bad((e) => { (e.actions[0]!.target as Record<string, unknown>).role = ''; })).toEqual([expect.stringMatching(/target\.role/)]);
  });

  it('상한: 액션 수·글자 길이·anchor 수를 넘으면 거부한다', () => {
    const many = { ...structuredClone(SAMPLE_ENTRY), actions: Array.from({ length: CACHE_LIMITS.actions + 1 }, () => ({ tool: 'back', summary: 'back' })) };
    expect(parseCacheEntry(many)).toMatchObject({ ok: false, errors: [expect.stringMatching(/actions/)] });
    const long = structuredClone(SAMPLE_ENTRY); long.actions[1]!.text = 'x'.repeat(CACHE_LIMITS.text + 1);
    expect(parseCacheEntry(long)).toMatchObject({ ok: false, errors: [expect.stringMatching(/text/)] });
    const anchors = structuredClone(SAMPLE_ENTRY); anchors.end.anchors = Array.from({ length: CACHE_LIMITS.anchors + 1 }, (_, i) => ({ role: 'text', label: `a${i}` }));
    expect(parseCacheEntry(anchors)).toMatchObject({ ok: false, errors: [expect.stringMatching(/anchors/)] });
  });

  it('키는 64자 소문자 16진수(sha256)', () => {
    expect(CACHE_KEY.test('a'.repeat(64))).toBe(true);
    expect(CACHE_KEY.test('A'.repeat(64))).toBe(false);
    expect(CACHE_KEY.test('../'.padEnd(64, 'a'))).toBe(false);
  });
});

cacheStoreContractSuite('memory', () => createMemoryCacheStore(), SAMPLE_ENTRY);
