// @vitest-environment node
// Studio 업데이트 배포(studio-update 02): --studio-releases-dir 의 latest-mac.json 이 최신 버전·파일을 정하고, 목록에 적힌 zip 만 내준다.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer } from '../src/index.ts';
import { parseReleaseManifest } from '../src/studio-releases.ts';
import { parseConfig, ConfigError } from '../src/config.ts';

let server: ControlPlaneServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const url = (p: string) => `http://127.0.0.1:${server!.port}${p}`;
const zip = Buffer.from('PK\u0003\u0004 가짜 zip');
const sha = createHash('sha256').update(zip).digest('hex');

function releasesDir(manifest?: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-rel-'));
  writeFileSync(path.join(dir, 'Sinclair-Studio-0.2.0-mac-arm64.zip'), zip);
  writeFileSync(path.join(dir, 'secret.txt'), '목록에 없음');
  if (manifest !== undefined) writeFileSync(path.join(dir, 'latest-mac.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
}
const good = { product: 'Sinclair Studio', version: '0.2.0', releasedAt: '2026-11-15T09:00:00Z', files: [{ arch: 'arm64', name: 'Sinclair-Studio-0.2.0-mac-arm64.zip', sha256: sha, size: zip.length }] };

describe('Studio 업데이트 배포', () => {
  it('최신 버전과 그 아키텍처 zip, 파일 바이트; 없는 아키텍처·목록 밖 파일·경로 조작은 404', async () => {
    server = await serveControlPlane(createMemoryEventStore(), { studioReleasesDir: releasesDir(good) });
    const r = await fetch(url('/studio/releases/latest?arch=arm64'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ version: '0.2.0', releasedAt: '2026-11-15T09:00:00Z', arch: 'arm64', name: 'Sinclair-Studio-0.2.0-mac-arm64.zip', sha256: sha, size: zip.length, url: '/studio/releases/files/Sinclair-Studio-0.2.0-mac-arm64.zip' });
    const f = await fetch(url('/studio/releases/files/Sinclair-Studio-0.2.0-mac-arm64.zip'));
    expect(f.status).toBe(200);
    expect(f.headers.get('content-length')).toBe(String(zip.length));
    expect(Buffer.from(await f.arrayBuffer()).equals(zip)).toBe(true);
    expect((await fetch(url('/studio/releases/latest?arch=x64'))).status).toBe(404);
    expect((await fetch(url('/studio/releases/latest?arch=ppc'))).status).toBe(400);
    for (const p of ['/studio/releases/files/secret.txt', '/studio/releases/files/..%2Flatest-mac.json', '/studio/releases/files/%2Fetc%2Fpasswd']) expect((await fetch(url(p))).status, p).toBe(404);
  });

  it('배포 디렉터리 없음·목록 없음은 404(no-releases), 깨진 목록은 500, 크기가 다른 파일은 주지 않는다', async () => {
    server = await serveControlPlane(createMemoryEventStore(), {});
    expect(await (await fetch(url('/studio/releases/latest?arch=arm64'))).json()).toMatchObject({ code: 'no-releases' });
    await server.close();
    server = await serveControlPlane(createMemoryEventStore(), { studioReleasesDir: releasesDir() });
    const none = await fetch(url('/studio/releases/latest?arch=arm64'));
    expect([none.status, (await none.json() as { code: string }).code]).toEqual([404, 'no-releases']);
    await server.close();
    server = await serveControlPlane(createMemoryEventStore(), { studioReleasesDir: releasesDir('{ 깨짐') });
    expect((await fetch(url('/studio/releases/latest?arch=arm64'))).status).toBe(500);
    await server.close();
    server = await serveControlPlane(createMemoryEventStore(), { studioReleasesDir: releasesDir({ ...good, files: [{ ...good.files[0], size: zip.length + 1 }] }) });
    expect((await fetch(url('/studio/releases/files/Sinclair-Studio-0.2.0-mac-arm64.zip'))).status).toBe(404);
  });

  it('목록 검증: 버전 형식·아키텍처·zip 이름(경로 문자 없음)·sha256·크기', () => {
    expect(parseReleaseManifest(good).ok).toBe(true);
    for (const bad of [{ ...good, version: 'v2' }, { ...good, files: [{ ...good.files[0], arch: 'ia32' }] }, { ...good, files: [{ ...good.files[0], name: '../x.zip' }] }, { ...good, files: [{ ...good.files[0], name: 'x.dmg' }] }, { ...good, files: [{ ...good.files[0], sha256: 'abc' }] }, { ...good, files: [{ ...good.files[0], size: 0 }] }]) expect(parseReleaseManifest(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('설정: --studio-releases-dir(없는 디렉터리는 기동 오류)', () => {
    const dir = releasesDir(good);
    const cfg = (argv: string[]) => { const c = parseConfig(argv, {}, 'linux'); if ('help' in c) throw new Error('help'); return c; };
    expect(cfg(['--store', 'memory', '--studio-releases-dir', dir]).studioReleasesDir).toBe(path.resolve(dir));
    expect(cfg(['--store', 'memory']).studioReleasesDir).toBeUndefined();
    expect(() => parseConfig(['--studio-releases-dir', '/no/such/dir'], {}, 'linux')).toThrow(ConfigError);
  });

  it('dist:studio 가 만든 목록(releaseManifest)이 이 검증을 통과한다', async () => {
    const { releaseManifest } = await import('../../../scripts/dist-studio.mjs');
    const dir = releasesDir();
    const m = releaseManifest({ version: '0.2.0', zips: [{ arch: 'arm64', path: path.join(dir, 'Sinclair-Studio-0.2.0-mac-arm64.zip') }], releasedAt: '2026-11-15T00:00:00.000Z' });
    expect(m).toEqual({ product: 'Sinclair Studio', version: '0.2.0', releasedAt: '2026-11-15T00:00:00.000Z', files: [{ arch: 'arm64', name: 'Sinclair-Studio-0.2.0-mac-arm64.zip', sha256: sha, size: zip.length }] });
    expect(parseReleaseManifest(m).ok).toBe(true);
  });
});
