// @vitest-environment node
// 배포본 조립: fetchNode(페이크 릴리스 서버, sha256 검증·캐시), 호스트 타깃 배포본을 임시 디렉터리에 조립해 런처로 서버·에이전트를 돌린다, Windows 타깃 구성.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchNode, assembleDistributable, NODE_VERSION, TARGETS } from '../../../scripts/dist.mjs';
import { helperApkFileName } from '../src/index.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const HELPER_APK = path.join(repo, 'packages/device-layer/android-helper/app/build/outputs/apk/debug/app-debug.apk');
const hostTarget = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : process.platform === 'win32' ? (process.arch === 'arm64' ? 'win-arm64' : 'win-x64') : undefined;
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const canRun = !!hostTarget && fs.existsSync(HELPER_APK) && (major > 22 || (major === 22 && minor >= 18));

const children: ChildProcess[] = [];
afterEach(() => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); children.length = 0; });

describe('fetchNode', () => {
  it('SHASUMS256.txt 로 검증해 캐시에 풀고, 두 번째는 네트워크 없이 캐시를 쓴다; 체크섬이 다르면 거부한다', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-node-'));
    try {
      // 가짜 Node 배포 tar.gz: node-v<V>-darwin-x64/{bin/node,LICENSE}
      const dirName = `node-v${NODE_VERSION}-darwin-x64`;
      const src = path.join(tmp, 'src', dirName);
      fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(src, 'bin', 'node'), '#!/bin/sh\necho fake-node\n'); fs.chmodSync(path.join(src, 'bin', 'node'), 0o755);
      fs.writeFileSync(path.join(src, 'LICENSE'), 'MIT-ish');
      const tgz = path.join(tmp, `${dirName}.tar.gz`);
      execFileSync('tar', ['-czf', tgz, '-C', path.join(tmp, 'src'), dirName]);
      const bytes = fs.readFileSync(tgz);
      const sum = createHash('sha256').update(bytes).digest('hex');
      const hits: string[] = [];
      let badSum = false;
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        if (req.url === `/v${NODE_VERSION}/SHASUMS256.txt`) { res.end(`${badSum ? '0'.repeat(64) : sum}  ${dirName}.tar.gz\n${'f'.repeat(64)}  other.zip\n`); return; }
        if (req.url === `/v${NODE_VERSION}/${dirName}.tar.gz`) { res.end(bytes); return; }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const cacheDir = path.join(tmp, 'cache');
        const first = await fetchNode('mac-x64', { base, cacheDir });
        expect(first.fromCache).toBe(false);
        expect(fs.readFileSync(first.exe, 'utf8')).toContain('fake-node');
        expect(fs.existsSync(first.license)).toBe(true);
        expect(hits).toEqual([`/v${NODE_VERSION}/SHASUMS256.txt`, `/v${NODE_VERSION}/${dirName}.tar.gz`]);
        const second = await fetchNode('mac-x64', { base, cacheDir });
        expect(second.fromCache).toBe(true);
        expect(hits).toHaveLength(2);
        badSum = true;
        await expect(fetchNode('mac-x64', { base, cacheDir: path.join(tmp, 'cache2') })).rejects.toThrow(/sha256 불일치/);
        expect(fs.existsSync(path.join(tmp, 'cache2', dirName))).toBe(false);
      } finally { await new Promise<void>((r) => server.close(() => r())); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('fetchNode (Windows zip)', () => {
  it('zip 배포 파일도 tar 로 풀어 node.exe 와 LICENSE 를 찾는다', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-node-win-'));
    try {
      const dirName = `node-v${NODE_VERSION}-win-x64`;
      const src = path.join(tmp, 'src', dirName);
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'node.exe'), 'MZ fake');
      fs.writeFileSync(path.join(src, 'LICENSE'), 'MIT-ish');
      const zipPath = path.join(tmp, `${dirName}.zip`);
      execFileSync('zip', ['-qr', zipPath, dirName], { cwd: path.join(tmp, 'src') });
      const bytes = fs.readFileSync(zipPath);
      const sum = createHash('sha256').update(bytes).digest('hex');
      const server = http.createServer((req, res) => {
        if (req.url === `/v${NODE_VERSION}/SHASUMS256.txt`) { res.end(`${sum}  ${dirName}.zip\n`); return; }
        if (req.url === `/v${NODE_VERSION}/${dirName}.zip`) { res.end(bytes); return; }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      try {
        const got = await fetchNode('win-x64', { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, cacheDir: path.join(tmp, 'cache') });
        expect(got.exe.endsWith(path.join(dirName, 'node.exe'))).toBe(true);
        expect(fs.readFileSync(got.exe, 'utf8')).toBe('MZ fake');
        expect(fs.existsSync(got.license)).toBe(true);
      } finally { await new Promise<void>((r) => server.close(() => r())); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe.skipIf(!canRun)('호스트 배포본 (동봉 Node 대신 현재 Node 실행 파일)', { timeout: 120_000 }, () => { // 번들 + usb 패키지 확보 + 자식 프로세스 여럿
  let out: string; let install: string;
  const logs: string[] = [];
  beforeAll(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-dist-'));
    const r = await assembleDistributable({ target: hostTarget!, outDir: out, version: '0.0.0-test', nodeBinary: process.execPath, zip: true, log: (l) => logs.push(l) });
    // zip 을 풀어서 쓴다(배포 경로 그대로)
    install = path.join(out, 'unzipped');
    fs.mkdirSync(install);
    execFileSync('unzip', ['-q', r.zipPath!, '-d', install]);
    install = path.join(install, `sinclair-0.0.0-test-${hostTarget}`);
  }, 120_000); // 번들 빌드 + usb 패키지 복사 + zip/unzip: 전체 스위트 병렬 실행에서 10초 기본 훅 타임아웃을 넘긴다
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  function launch(bin: string, args: string[], env: Record<string, string> = {}, dir = install) {
    const child = spawn(path.join(dir, 'bin', bin), args, { cwd: os.tmpdir(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let text = '';
    child.stdout!.on('data', (d) => { text += d; }); child.stderr!.on('data', (d) => { text += d; });
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const ready = () => new Promise<number>((resolve, reject) => {
      const check = () => { const m = /READY .*port=(\d+)/.exec(text); if (m) resolve(Number(m[1])); };
      check(); child.stdout!.on('data', check);
      void exited.then((code) => reject(new Error(`READY 전에 종료(code ${code}): ${text}`)));
      setTimeout(() => reject(new Error(`READY 대기 초과: ${text}`)), 20_000).unref(); // 번들 로드 + sqlite 열기, 전체 스위트 병렬 실행 여유
    });
    return { child, exited, output: () => text, ready, stop: async () => { child.kill('SIGTERM'); return exited; } };
  }

  it('구성: 런처·node·dist·usb(플랫폼 패키지)·헬퍼 APK+sha256·VERSION·README 가 있고 zip 이 만들어진다', () => {
    const files = fs.readdirSync(install).sort();
    expect(files).toEqual(['README.md', 'VERSION', 'bin', 'dist', 'node', 'node_modules', 'resources']);
    expect(fs.readdirSync(path.join(install, 'bin')).sort()).toEqual(['sinclair-agent', 'sinclair-control-plane']);
    expect(fs.existsSync(path.join(install, 'node', TARGETS[hostTarget!]!.exe))).toBe(true);
    expect(fs.readdirSync(path.join(install, 'dist'))).toEqual(expect.arrayContaining(['control-plane.mjs', 'runner-agent.mjs', 'runner.mjs', 'hooks.mjs']));
    expect(fs.existsSync(path.join(install, 'node_modules', 'usb', 'package.json'))).toBe(true);
    expect(fs.readdirSync(path.join(install, 'node_modules', '@node-usb'))).toHaveLength(1);
    const apk = fs.readdirSync(path.join(install, 'resources', 'helper')).sort();
    expect(apk).toEqual([helperApkFileName(), `${helperApkFileName()}.sha256`]); // 에이전트가 찾는 이름과 같다(단일 출처)
    expect(fs.existsSync(path.join(install, 'node', 'LICENSE'))).toBe(true);
    const sum = fs.readFileSync(path.join(install, 'resources', 'helper', apk[1]!), 'utf8').slice(0, 64);
    expect(createHash('sha256').update(fs.readFileSync(path.join(install, 'resources', 'helper', apk[0]!))).digest('hex')).toBe(sum);
    expect(fs.readFileSync(path.join(install, 'VERSION'), 'utf8')).toContain(`node ${NODE_VERSION}`);
    const readme = fs.readFileSync(path.join(install, 'README.md'), 'utf8');
    expect(readme).toMatch(/설치 크기 약 \d+ MB/);
    expect(readme).toContain('quarantine');
    for (const section of ['## 설치', '## 업그레이드', '## 제거', '데이터 디렉터리', '## 알려진 한계']) expect(readme).toContain(section);
  });

  it('업그레이드: 새 설치 디렉터리의 런처가 기존 SQLite DB 를 그대로 열어 이전 run 을 돌려준다', async () => {
    const db = path.join(out, 'data', 'upgrade.db');
    const old = launch('sinclair-control-plane', ['--port', '0'], { SINCLAIR_CP_DB: db });
    const port = await old.ready();
    await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: JSON.stringify([{ schema: 1, eventId: 'u1', runId: 'r-up', at: '2026-11-08T00:00:00.000Z', type: 'run.started', targetId: 'android' }]) });
    const before = await (await fetch(`http://127.0.0.1:${port}/runs/r-up`)).text();
    expect(await old.stop()).toBe(0);
    // "새 버전" 설치본: 같은 zip 을 다른 디렉터리에 푼 것으로 흉내 낸다(데이터는 설치 디렉터리 밖에 있다)
    const next = path.join(out, 'install-next');
    fs.cpSync(install, next, { recursive: true });
    const upgraded = launch('sinclair-control-plane', ['--port', '0'], { SINCLAIR_CP_DB: db }, next);
    expect(await (await fetch(`http://127.0.0.1:${await upgraded.ready()}/runs/r-up`)).text()).toBe(before);
    expect(await upgraded.stop()).toBe(0);
  });

  it('런처: control-plane 이 sqlite 기본으로 READY → ingest → SIGTERM 정상 종료; 환경변수가 통과한다', async () => {
    const db = path.join(out, 'data', 'cp.db');
    const cp = launch('sinclair-control-plane', ['--port', '0'], { SINCLAIR_CP_DB: db });
    const port = await cp.ready();
    expect(cp.output()).toMatch(/store=sqlite db=.*cp\.db/);
    const r = await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: JSON.stringify([{ schema: 1, eventId: 'd1', runId: 'r1', at: '2026-11-08T00:00:00.000Z', type: 'run.started', targetId: 'android' }]) });
    expect(((await r.json()) as { accepted: number }).accepted).toBe(1);
    expect(await cp.stop()).toBe(0);
    expect(cp.output()).toContain('종료 완료');
  });

  it('런처: agent run --engine fake 가 verified; --engine mobile 은 기기 없음 blocked(2) 로 끝난다(usb 모듈·번들 APK 가 로드됨)', async () => {
    const cp = launch('sinclair-control-plane', ['--port', '0', '--store', 'memory']);
    const url = `http://127.0.0.1:${await cp.ready()}`;
    await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'd', build: 'b', targets: ['android'] }) });
    const tests = path.join(out, 'tests'); fs.mkdirSync(tests, { recursive: true });
    fs.writeFileSync(path.join(tests, 'login.sinclair.ts'), `import { test } from '@sinclair/runner';\ntest('로그인', async ({ screen, expect }) => { await screen.getByRole('button', { name: '로그인' }).tap(); await expect(screen.getByText('환영합니다')).toBeVisible(); });\n`);
    // 엔진·스풀은 환경변수로 넘겨 SINCLAIR_AGENT_* 가 런처를 통과함을 본다
    const fake = launch('sinclair-agent', ['run', '--control-plane', url, '--cycle', 'd', '--target', 'android', '--tests', tests], { SINCLAIR_AGENT_ENGINE: 'fake', SINCLAIR_AGENT_SPOOL: path.join(out, 'spool') });
    expect(await fake.exited).toBe(0);
    expect(((await (await fetch(`${url}/cycles/d`)).json()) as { verdict: string }).verdict).toBe('verified');

    await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'm', build: 'b', targets: ['android'] }) });
    const mobile = launch('sinclair-agent', ['run', '--control-plane', url, '--cycle', 'm', '--target', 'android', '--tests', tests, '--engine', 'mobile', '--device', 'NO-SUCH-DEVICE', '--spool', path.join(out, 'spool'), '--helper-cache', path.join(out, 'cache')],
      { SINCLAIR_AGENT_HELPER_APK: '', SINCLAIR_AGENT_HELPER_URL: '' });
    expect(await mobile.exited).toBe(2);
    expect(mobile.output()).toContain(`resources/helper/${helperApkFileName()} (bundled)`); // 번들 APK 가 해석됐다
    expect(mobile.output()).toMatch(/기기 NO-SUCH-DEVICE 가 목록에 없음|꽂힌 Android 기기가 없음/); // usb 모듈이 로드돼 목록 조회까지 갔다
    await cp.stop();
  }, 120_000); // USB 열거 + 승인 대기 상한(기기 지정이라 목록 재시도 3초) 여유
});

describe('조립 실패 경로', () => {
  it('헬퍼 APK 가 없으면 빌드 안내와 함께 실패한다', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-dist-noapk-'));
    try {
      await expect(assembleDistributable({ target: 'mac-x64', outDir: out, nodeBinary: process.execPath, zip: false, log: () => {}, helperApk: path.join(out, 'missing.apk') })).rejects.toThrow(/헬퍼 APK 가 없음[\s\S]*gradlew assembleDebug/);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });
});

describe.skipIf(!fs.existsSync(HELPER_APK))('Windows 타깃 조립(mac 에서 교차)', () => {
  it('node.exe 와 .cmd 런처, win32 usb 패키지가 들어간다 (Node 는 가짜 실행 파일로 대체)', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-dist-win-'));
    try {
      const fakeExe = path.join(out, 'fake-node.exe'); fs.writeFileSync(fakeExe, 'MZ');
      const fakeLicense = path.join(out, 'LICENSE'); fs.writeFileSync(fakeLicense, 'fake');
      const r = await assembleDistributable({ target: 'win-x64', outDir: out, version: '0.0.0-test', nodeBinary: fakeExe, nodeLicense: fakeLicense, zip: false, log: () => {} });
      expect(r.files).toEqual(expect.arrayContaining(['bin/sinclair-agent.cmd', 'bin/sinclair-control-plane.cmd', 'node/node.exe', 'node/LICENSE', 'node_modules/@node-usb/', 'node_modules/usb/', `resources/helper/${helperApkFileName()}`]));
      expect(fs.existsSync(path.join(r.stageDir, 'node_modules', '@node-usb', 'usb-win32-x64-msvc', 'package.json'))).toBe(true);
      expect(r.files.some((f) => f === 'bin/sinclair-agent')).toBe(false);
      const cmd = fs.readFileSync(path.join(r.stageDir, 'bin', 'sinclair-agent.cmd'), 'utf8');
      expect(cmd.startsWith('@echo off\r\n')).toBe(true); // CRLF, 에코 끔
      expect(cmd).toContain('set "DIR=%~dp0.."'); // 런처 위치 기준 상위 디렉터리
      expect(cmd).toMatch(/"%DIR%\\node\\node\.exe" --no-warnings=ExperimentalWarning "%DIR%\\dist\\runner-agent\.mjs" %\*/); // 플래그 하나, 인자 전달
      expect(cmd).toContain('exit /b %ERRORLEVEL%'); // 종료 코드 보존
      const readme = fs.readFileSync(path.join(r.stageDir, 'README.md'), 'utf8');
      for (const s of ['## Windows', 'WinUSB', '%APPDATA%', 'Ctrl-C', 'windows-checklist']) expect(readme).toContain(s);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }, 120_000); // npm pack 으로 win 플랫폼 패키지를 처음 받을 수 있다
});
