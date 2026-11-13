// 녹화 캐시(recording-cache 01): 키 계산과 파일 저장소. 항목 모양·저장소 계약은 protocol(recording-cache.ts)이 정한다.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertCacheKey, parseCacheEntry, CACHE_SCHEMA, type CacheStore } from '@sinclair/protocol';

/** 재생 정책 버전: 재탐색·확인 규칙을 바꾸면 올려서 모든 녹화를 새로 만든다 */
export const CACHE_POLICY = 'exact/2';
export const CACHE_MODES = ['off', 'read-only', 'read-write', 'strict'] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

export interface CacheKeyFields {
  testId: string;
  /** 엔진 이름(mobile·fake…): 다른 엔진의 녹화를 섞지 않는다 */
  engine: string;
  /** act 시작 화면의 foreground 앱(모르면 '') */
  app: string;
  instruction: string;
  /** 같은 테스트 안에서 같은 instruction 의 act 가 몇 번째인가(0 부터). 테스트 안 위치가 아니다 — 앞에 선택적 스텝이 끼어도 밀리지 않게 */
  callIndex: number;
}

export const normalizeInstruction = (s: string): string => s.replace(/\r\n?/g, '\n').normalize('NFC').trim();

/** 키 필드의 canonical JSON(고정 순서) sha256. 모델·엔진 버전은 넣지 않는다 — 릴리스마다 녹화가 모두 식지 않게(어긋나면 이어받기가 고친다) */
export function cacheKey(f: CacheKeyFields): string {
  const canonical = JSON.stringify([CACHE_SCHEMA, CACHE_POLICY, f.testId, f.engine, f.app, normalizeInstruction(f.instruction), f.callIndex]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** <dir>/<key>.json. 원자적 쓰기(임시 파일 → rename), 0600. 깨졌거나 계약을 통과하지 못하는 파일은 미스 */
export function createFileCacheStore(dir: string): CacheStore {
  const fileOf = (key: string): string => { assertCacheKey(key); return path.join(dir, `${key}.json`); };
  return {
    async read(key) {
      const file = fileOf(key);
      let raw: string;
      try { raw = await fs.readFile(file, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return undefined; }
      const parsed = parseCacheEntry(json);
      return parsed.ok ? parsed.value : undefined;
    },
    async write(key, entry) {
      const file = fileOf(key);
      const parsed = parseCacheEntry(entry);
      if (!parsed.ok) throw new Error(`녹화 캐시 항목이 계약을 통과하지 못함: ${parsed.errors.join('; ')}`);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(tmp, file);
    },
    async delete(key) {
      await fs.rm(fileOf(key), { force: true });
    },
  };
}
