// @vitest-environment node
// 녹화 캐시 공유 저장(recording-cache 05): GET/PUT/DELETE /cache/:key — 노드 하나가 녹화하면 플릿 전체가 재생한다. SQLite 스키마 5.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cacheStoreContractSuite, SAMPLE_CACHE_ENTRY } from '@sinclair/protocol/testing';
import { createMemoryEventStore, createSqliteCacheStore, openSqlite, serveControlPlane, SQLITE_SCHEMA_VERSION, type ControlPlaneServer } from '../src/index.ts';

cacheStoreContractSuite('control-plane SQLite', () => createSqliteCacheStore(openSqlite(':memory:')));

describe('/cache/:key', () => {
  let server: ControlPlaneServer;
  beforeEach(async () => { server = await serveControlPlane(createMemoryEventStore()); });
  afterEach(async () => { await server.close(); });
  const url = (k: string) => `http://127.0.0.1:${server.port}/cache/${k}`;
  const K = 'c'.repeat(64);

  it('PUT 뒤 GET 은 같은 항목, 없는 키는 404, DELETE 뒤 404(없는 키 DELETE 도 204)', async () => {
    expect((await fetch(url(K))).status).toBe(404);
    expect((await fetch(url(K), { method: 'PUT', body: JSON.stringify(SAMPLE_CACHE_ENTRY) })).status).toBe(204);
    const got = await fetch(url(K));
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(SAMPLE_CACHE_ENTRY);
    expect((await fetch(url(K), { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(url(K))).status).toBe(404);
    expect((await fetch(url(K), { method: 'DELETE' })).status).toBe(204);
  });

  it('키 모양이 틀리면 400, 계약을 통과하지 못하는 항목은 400 과 검증 오류', async () => {
    expect((await fetch(url('A'.repeat(64)))).status).toBe(400);
    expect((await fetch(url('..%2F' + 'a'.repeat(60)), { method: 'PUT', body: JSON.stringify(SAMPLE_CACHE_ENTRY) })).status).toBe(400);
    const bad = await fetch(url(K), { method: 'PUT', body: JSON.stringify({ ...SAMPLE_CACHE_ENTRY, schema: 'rc-0' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ errors: [expect.stringMatching(/schema/)] });
  });

  it('SQLite 스키마는 5(recording_cache)', () => {
    expect(SQLITE_SCHEMA_VERSION).toBe(5);
  });
});
