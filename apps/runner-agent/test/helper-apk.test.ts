// @vitest-environment node
// resolveHelperApk: 플래그 → env → 번들 → 리포 빌드 → 다운로드(sha256 사이드카 검증, 캐시). 단계마다 실패 사유를 남긴다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveHelperApk, HelperApkError, HELPER_APK_VERSION, helperApkFileName } from '../src/index.ts';

let dir: string;
const apkBytes = Buffer.from('PK\u0003\u0004 fake helper apk ' + HELPER_APK_VERSION);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const write = (p: string, content: Buffer | string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };

/** 페이크 릴리스 서버: <base>/<file> 과 <file>.sha256 */
async function releaseServer(files: Record<string, Buffer | string>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const body = files[(req.url ?? '').replace(/^\//, '')];
    if (body === undefined) { res.writeHead(404).end(); return; }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}/release`, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-apk-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('resolveHelperApk', () => {
  it('플래그 > env > 번들 > 리포 빌드 순으로 처음 존재하는 파일을 쓰고 source 를 알려 준다', async () => {
    const flag = write(path.join(dir, 'flag.apk'), apkBytes);
    const env = write(path.join(dir, 'env.apk'), apkBytes);
    const bundled = write(path.join(dir, 'bundled', helperApkFileName()), apkBytes);
    const repo = write(path.join(dir, 'repo.apk'), apkBytes);
    const logs: string[] = [];
    const base = { bundledDir: path.join(dir, 'bundled'), repoBuild: repo, cacheDir: path.join(dir, 'cache'), log: (l: string) => logs.push(l) };
    expect(await resolveHelperApk({ ...base, flag, env: { SINCLAIR_AGENT_HELPER_APK: env } })).toEqual({ path: flag, source: 'flag' });
    expect(await resolveHelperApk({ ...base, env: { SINCLAIR_AGENT_HELPER_APK: env } })).toEqual({ path: env, source: 'env' });
    expect(await resolveHelperApk({ ...base, env: {} })).toEqual({ path: bundled, source: 'bundled' });
    fs.rmSync(bundled);
    expect(await resolveHelperApk({ ...base, env: {} })).toEqual({ path: repo, source: 'repo-build' });
    expect(logs.at(-1)).toMatch(/헬퍼 APK: .*repo\.apk \(repo-build\)/);
  });

  it('플래그·env 가 가리키는 파일이 없으면 그 사유를 남기고 다음 단계로 간다; 전부 실패하면 모든 사유가 든 HelperApkError', async () => {
    const logs: string[] = [];
    await expect(resolveHelperApk({ flag: path.join(dir, 'nope.apk'), env: { SINCLAIR_AGENT_HELPER_APK: path.join(dir, 'nope2.apk') }, bundledDir: path.join(dir, 'b'), repoBuild: path.join(dir, 'r.apk'), cacheDir: path.join(dir, 'c'), log: (l) => logs.push(l) }))
      .rejects.toThrow(HelperApkError);
    try { await resolveHelperApk({ flag: path.join(dir, 'nope.apk'), env: {}, bundledDir: path.join(dir, 'b'), repoBuild: path.join(dir, 'r.apk'), cacheDir: path.join(dir, 'c') }); }
    catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/flag: .*nope\.apk 없음/);
      expect(msg).toMatch(/bundled: /); expect(msg).toMatch(/repo-build: /); expect(msg).toMatch(/download: 릴리스 URL 없음/);
    }
  });

  it('다운로드: 사이드카 sha256 이 맞으면 캐시에 저장하고, 두 번째 호출은 네트워크 없이 캐시를 쓴다', async () => {
    const name = helperApkFileName();
    const srv = await releaseServer({ [`release/${name}`]: apkBytes, [`release/${name}.sha256`]: `${sha(apkBytes)}  ${name}\n` });
    try {
      const logs: string[] = [];
      const opts = { env: { SINCLAIR_AGENT_HELPER_URL: srv.base }, bundledDir: path.join(dir, 'b'), repoBuild: path.join(dir, 'r.apk'), cacheDir: path.join(dir, 'cache'), log: (l: string) => logs.push(l) };
      const first = await resolveHelperApk(opts);
      expect(first).toEqual({ path: path.join(dir, 'cache', name), source: 'download' });
      expect(fs.readFileSync(first.path)).toEqual(apkBytes);
      expect(srv.hits).toEqual([`/release/${name}.sha256`, `/release/${name}`]);
      const second = await resolveHelperApk(opts);
      expect(second).toEqual({ path: path.join(dir, 'cache', name), source: 'cache' });
      expect(srv.hits).toHaveLength(2); // 추가 요청 없음
    } finally { await srv.close(); }
  });

  it('체크섬이 다르면 거부하고 캐시에 남기지 않는다; 사이드카가 없으면 받지 않는다', async () => {
    const name = helperApkFileName();
    const bad = await releaseServer({ [`release/${name}`]: apkBytes, [`release/${name}.sha256`]: `${'0'.repeat(64)}  ${name}\n` });
    try {
      await expect(resolveHelperApk({ env: { SINCLAIR_AGENT_HELPER_URL: bad.base }, bundledDir: path.join(dir, 'b'), repoBuild: path.join(dir, 'r.apk'), cacheDir: path.join(dir, 'cache') })).rejects.toThrow(/sha256 불일치/);
      expect(fs.existsSync(path.join(dir, 'cache', name))).toBe(false);
    } finally { await bad.close(); }
    const noSidecar = await releaseServer({ [`release/${name}`]: apkBytes });
    try {
      await expect(resolveHelperApk({ env: { SINCLAIR_AGENT_HELPER_URL: noSidecar.base }, bundledDir: path.join(dir, 'b'), repoBuild: path.join(dir, 'r.apk'), cacheDir: path.join(dir, 'cache') })).rejects.toThrow(/sha256 사이드카.*404/);
      expect(noSidecar.hits).toEqual([`/release/${name}.sha256`]); // 사이드카 없으면 APK 는 받지도 않는다
    } finally { await noSidecar.close(); }
  });

  it('캐시된 파일이 사이드카와 다르면(손상) 다시 받는다', async () => {
    const name = helperApkFileName();
    const srv = await releaseServer({ [`release/${name}`]: apkBytes, [`release/${name}.sha256`]: sha(apkBytes) });
    try {
      write(path.join(dir, 'cache', name), 'corrupt');
      const got = await resolveHelperApk({ env: { SINCLAIR_AGENT_HELPER_URL: srv.base }, bundledDir: path.join(dir, 'b'), repoBuild: path.join(dir, 'r.apk'), cacheDir: path.join(dir, 'cache') });
      expect(got.source).toBe('download');
      expect(fs.readFileSync(got.path)).toEqual(apkBytes);
    } finally { await srv.close(); }
  });
});
