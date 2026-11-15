// @vitest-environment node
// Studio 자동 업데이트(studio-update 03): 버전 비교, 최신 배포 확인, 받기(크기·sha256), 풀어 번들 id·버전 확인, 교체 sh(실제 sh·ditto·plutil, mac).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appBundleOf, compareVersions, createUpdater, downloadVerified, installBlocker, swapScript } from '../src/main/updater.ts';
import type { UpdateStatus } from '../src/shared/update.ts';

const mac = process.platform === 'darwin';
const tmpDir = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'studio-upd-')));
const bytesFetch = (files: Record<string, Buffer | { status: number; json?: unknown }>) => async (url: string): Promise<Response> => {
  const f = files[url];
  if (!f) return new Response('없음', { status: 404 });
  if (Buffer.isBuffer(f)) return new Response(new Uint8Array(f), { status: 200 });
  return new Response(JSON.stringify(f.json ?? {}), { status: f.status });
};

/** 가짜 .app(Info.plist 만) */
function fakeApp(dir: string, version: string, id = 'dev.sinclair.studio', marker = version): string {
  const app = path.join(dir, 'Sinclair Studio.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  const plist = path.join(app, 'Contents', 'Info.plist');
  writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>');
  execFileSync('plutil', ['-insert', 'CFBundleIdentifier', '-string', id, plist]);
  execFileSync('plutil', ['-insert', 'CFBundleShortVersionString', '-string', version, plist]);
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'marker'), marker);
  return app;
}
const run = async (cmd: string, args: string[]): Promise<string> => execFileSync(cmd, args, { encoding: 'utf8' });

describe('compareVersions·appBundleOf', () => {
  it('x.y.z 숫자 비교, 같으면 pre 없는 쪽이 새것, 형식 아니면 NaN', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('v1', '1.0.0')).toBeNaN();
  });
  it('실행 파일에서 .app, 아니면 undefined', () => {
    expect(appBundleOf('/Applications/Sinclair Studio.app/Contents/MacOS/Sinclair Studio')).toBe('/Applications/Sinclair Studio.app');
    expect(appBundleOf('/repo/node_modules/electron/dist/Electron')).toBeUndefined();
  });
  it('디스크 이미지·격리 위치·쓸 수 없는 폴더는 막는다', async () => {
    expect(await installBlocker('/Volumes/Sinclair Studio 0.1.0/Sinclair Studio.app')).toMatch(/디스크 이미지/);
    expect(await installBlocker('/private/var/folders/x/AppTranslocation/ABC/d/Sinclair Studio.app')).toMatch(/격리/);
    expect(await installBlocker('/no/such/Sinclair Studio.app')).toMatch(/쓸 수 없음/);
  });
});

describe('downloadVerified', () => {
  it('크기·sha256 이 맞으면 dest, 아니면 지우고 실패(.part 도 남지 않음)', async () => {
    const dir = tmpDir();
    const body = Buffer.from('zip 바이트'.repeat(100));
    const sha = createHash('sha256').update(body).digest('hex');
    const seen: number[] = [];
    await downloadVerified('u', { sha256: sha, size: body.length }, path.join(dir, 'a.zip'), bytesFetch({ u: body }), (n) => seen.push(n));
    expect(readFileSync(path.join(dir, 'a.zip')).equals(body)).toBe(true);
    expect(seen.at(-1)).toBe(body.length);
    await expect(downloadVerified('u', { sha256: '0'.repeat(64), size: body.length }, path.join(dir, 'b.zip'), bytesFetch({ u: body }))).rejects.toThrow(/sha256/);
    await expect(downloadVerified('u', { sha256: sha, size: body.length - 1 }, path.join(dir, 'c.zip'), bytesFetch({ u: body }))).rejects.toThrow(/크기/);
    for (const f of ['b.zip', 'b.zip.part', 'c.zip', 'c.zip.part']) expect(existsSync(path.join(dir, f)), f).toBe(false);
  });
});

describe.skipIf(!mac)('createUpdater → swapScript(실제 ditto·plutil·sh)', () => {
  async function setup(release: { version: string; id?: string; zipVersion?: string }) {
    const dir = tmpDir();
    const installed = fakeApp(path.join(dir, 'Applications'), '0.1.0');
    const src = fakeApp(path.join(dir, 'build'), release.zipVersion ?? release.version, release.id, `new ${release.version}`);
    const zip = path.join(dir, 'build', 'r.zip');
    execFileSync('ditto', ['-c', '-k', '--keepParent', src, zip]);
    const bytes = readFileSync(zip);
    const name = `Sinclair-Studio-${release.version}-mac-arm64.zip`;
    const statuses: UpdateStatus[] = [];
    const spawned: Array<{ script: string; log: string }> = [];
    let quit = 0;
    const u = createUpdater({
      current: '0.1.0', arch: 'arm64', app: installed, bundleId: 'dev.sinclair.studio', workDir: path.join(dir, 'work'), pid: 99_999_999,
      controlPlane: async () => 'http://cp',
      fetch: bytesFetch({
        'http://cp/studio/releases/latest?arch=arm64': { status: 200, json: { version: release.version, name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, url: `/studio/releases/files/${name}` } },
        [`http://cp/studio/releases/files/${name}`]: bytes,
      }),
      run, spawnDetached: (script, log) => spawned.push({ script, log }), quit: () => { quit++; },
      relaunchEnv: { SINCLAIR_STUDIO_USER_DATA: '/tmp/ud x' },
      onChange: (s) => statuses.push(s),
    });
    return { dir, installed, u, statuses, spawned, quit: () => quit };
  }

  it('확인 → available, 설치 → 받기·풀기·검사 뒤 교체 sh 를 띄우고 끝낸다; sh 가 앱을 바꾸고 다시 띄운다', async () => {
    const t = await setup({ version: '0.2.0' });
    expect(await t.u.check(true)).toMatchObject({ state: 'available', version: '0.2.0' });
    await t.u.install();
    expect(t.statuses.map((s) => s.state)).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'installing']));
    expect(t.statuses.at(-1)?.state).toBe('installing');
    expect(t.quit()).toBe(1);
    expect(t.spawned).toHaveLength(1);
    // 교체 sh: 끝난 pid, PATH 의 가짜 open 이 인자를 남긴다
    const bin = path.join(t.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(t.dir, 'opened'))}\n`);
    chmodSync(path.join(bin, 'open'), 0o755);
    const r = spawnSync('/bin/sh', [t.spawned[0]!.script], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(path.join(t.installed, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('new 0.2.0');
    expect(execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(t.installed, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()).toBe('0.2.0');
    expect(existsSync(`${t.installed}.updating-old`)).toBe(false);
    expect(readFileSync(path.join(t.dir, 'opened'), 'utf8').split('\n').filter(Boolean)).toEqual([t.installed, '--env', 'SINCLAIR_STUDIO_USER_DATA=/tmp/ud x']);
  });

  it('같거나 옛 버전은 idle, 다른 번들 id·목록과 다른 버전의 zip 은 error 로 멈추고 끝내지 않는다', async () => {
    expect((await (await setup({ version: '0.1.0' })).u.check(true)).state).toBe('idle');
    const other = await setup({ version: '0.2.0', id: 'com.evil.app' });
    await other.u.check(true);
    expect(await other.u.install()).toMatchObject({ state: 'error', error: expect.stringMatching(/다른 앱/) });
    expect(other.quit()).toBe(0);
    const mismatch = await setup({ version: '0.2.0', zipVersion: '0.1.5' });
    await mismatch.u.check(true);
    expect(await mismatch.u.install()).toMatchObject({ state: 'error', error: expect.stringMatching(/버전 0\.1\.5/) });
    expect(readFileSync(path.join(mismatch.installed, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('0.1.0');
  });

  it('교체 sh: Studio 가 끝날 때까지 기다리고, 새 앱을 못 넣으면 옛 앱을 되돌린다', async () => {
    const dir = tmpDir();
    const app = fakeApp(path.join(dir, 'Applications'), '0.1.0');
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'open'), 0o755);
    // node 의 자식이면 끝나도 좀비로 남아 kill -0 이 성공한다 — 셸이 띄우고 떠나 launchd 가 거두게 한다(실제 Studio 도 sh 의 부모일 뿐 자식이 아니다)
    const sleeperPid = Number(execFileSync('/bin/sh', ['-c', 'sleep 0.5 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
    const script = path.join(dir, 'swap.sh');
    writeFileSync(script, swapScript({ pid: sleeperPid, app, staged: path.join(dir, 'no-such-staged.app') }));
    const t0 = Date.now();
    const r = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(r.stdout).toMatch(/되돌림/);
    expect(readFileSync(path.join(app, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('0.1.0');
  });

  it('설치본이 아니면 unsupported(확인도 하지 않는다), 주기 확인 실패는 조용히 idle note', async () => {
    const calls: string[] = [];
    const base = { current: '0.1.0', arch: 'x64', bundleId: 'dev.sinclair.studio', workDir: tmpDir(), pid: 1, controlPlane: async () => 'http://cp', run, spawnDetached: () => {}, quit: () => {}, onChange: () => {} };
    const dev = createUpdater({ ...base, unsupportedReason: '개발 모드', fetch: async (u) => { calls.push(u); return new Response('', { status: 500 }); } });
    expect(await dev.check(true)).toEqual({ state: 'unsupported', current: '0.1.0', reason: '개발 모드' });
    expect(calls).toEqual([]);
    const down = createUpdater({ ...base, app: '/Applications/Sinclair Studio.app', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await down.check()).toMatchObject({ state: 'idle', note: 'ECONNREFUSED' });
    expect(await down.check(true)).toMatchObject({ state: 'error', error: 'ECONNREFUSED' });
    const none = createUpdater({ ...base, app: '/Applications/Sinclair Studio.app', fetch: async () => new Response('{}', { status: 404 }) });
    expect(await none.check(true)).toMatchObject({ state: 'idle', note: expect.stringMatching(/배포된 Studio 가 없음/) });
  });
});
