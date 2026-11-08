// @vitest-environment node
// 번들(dist)을 리포 밖 임시 디렉터리에 복사해 node_modules 없이 일반 Node 로 돌린다: control-plane READY/ingest/sqlite 재기동, agent run --engine fake(훅으로 '@sinclair/runner' 해석), 자산 경로 규칙.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildBundles } from '../../../scripts/build-bundles.mjs';

let installDir: string; // 임시 설치 디렉터리: <installDir>/dist/*.mjs, <installDir>/resources, <installDir>/tests
/** 사용자 .ts 테스트 파일은 Node 네이티브 타입 스트리핑(22.18+)에 의존한다 */
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const nodeStripsTypes = major > 22 || (major === 22 && minor >= 18);
const children: ChildProcess[] = [];
afterEach(() => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); children.length = 0; });

beforeAll(async () => {
  installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-bundle-'));
  await buildBundles(path.join(installDir, 'dist')); // 리포 밖 outdir 로 바로 빌드
  fs.mkdirSync(path.join(installDir, 'tests'));
  fs.writeFileSync(path.join(installDir, 'tests', 'login.sinclair.ts'), `import { test } from '@sinclair/runner';\ntest('로그인', async ({ screen, expect }) => { await screen.getByRole('button', { name: '로그인' }).tap(); await expect(screen.getByText('환영합니다')).toBeVisible(); });\n`);
}, 60_000); // esbuild 빌드는 보통 1~2초, 느린 CI 여유
afterAll(() => fs.rmSync(installDir, { recursive: true, force: true }));

function run(bundle: string, args: string[], env: Record<string, string> = {}) {
  // 리포 밖 cwd, node_modules 없음, 플래그는 node:sqlite 경고만 끈다
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(installDir, 'dist', bundle), ...args], { cwd: installDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; }); child.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const ready = () => new Promise<number>((resolve, reject) => {
    const check = () => { const m = /READY .*port=(\d+)/.exec(out); if (m) resolve(Number(m[1])); };
    check(); child.stdout!.on('data', check);
    void exited.then((code) => reject(new Error(`READY 전에 종료(code ${code}): ${out}`)));
    setTimeout(() => reject(new Error(`READY 대기 초과: ${out}`)), 15_000).unref(); // 번들 로드 + sqlite 열기, 전체 스위트 병렬 실행 여유
  });
  return { child, exited, output: () => out, ready, stop: async () => { child.kill('SIGTERM'); return exited; } };
}

describe.skipIf(!nodeStripsTypes)('번들 (리포 밖, node_modules 없음)', { timeout: 60_000 }, () => { // 자식 프로세스 여러 개 × 번들 로드
  it('산출물은 두 CLI, runner 공개 API, 훅, 공유 청크이고 리포 경로가 들어 있지 않다', () => {
    const names = fs.readdirSync(path.join(installDir, 'dist')).sort();
    expect(names).toEqual(expect.arrayContaining(['control-plane.mjs', 'runner-agent.mjs', 'runner.mjs', 'hooks.mjs']));
    expect(names.some((n) => /^chunk-.*\.mjs$/.test(n))).toBe(true);
    const repo = path.resolve(import.meta.dirname, '../../..');
    for (const n of names) expect(fs.readFileSync(path.join(installDir, 'dist', n), 'utf8')).not.toContain(repo);
    expect(fs.readFileSync(path.join(installDir, 'dist', 'runner-agent.mjs'), 'utf8')).toMatch(/import\("usb"\)/); // usb 만 external(지연 import 그대로)
  });

  it('control-plane: --help, sqlite 로 READY → ingest → SIGTERM → 같은 DB 로 재기동하면 run 이 남아 있다', async () => {
    const help = run('control-plane.mjs', ['--help']);
    expect(await help.exited).toBe(0);
    expect(help.output()).toContain('사용법: sinclair-control-plane');
    const db = path.join(installDir, 'data', 'cp.db');
    const a = run('control-plane.mjs', ['--port', '0', '--db', db]);
    const port = await a.ready();
    expect(a.output()).toMatch(/store=sqlite .*schema=\d+/);
    const ev = { schema: 1, eventId: 'b1', runId: 'r1', at: '2026-11-08T00:00:00.000Z', type: 'run.started', targetId: 'android' };
    expect(((await (await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: JSON.stringify([ev]) })).json()) as { accepted: number }).accepted).toBe(1);
    expect(await a.stop()).toBe(0);
    const b = run('control-plane.mjs', ['--port', '0', '--db', db]);
    expect((await fetch(`http://127.0.0.1:${await b.ready()}/runs/r1`)).status).toBe(200);
    await b.stop();
  });

  it('agent: run --engine fake 가 훅으로 해석한 테스트 파일을 돌려 Cycle 이 verified; resume --help; 모르는 명령은 3', async () => {
    const cp = run('control-plane.mjs', ['--port', '0', '--store', 'memory']);
    const port = await cp.ready();
    const url = `http://127.0.0.1:${port}`;
    await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'b', build: 'b', targets: ['android'] }) });
    const agent = run('runner-agent.mjs', ['run', '--control-plane', url, '--cycle', 'b', '--target', 'android', '--tests', path.join(installDir, 'tests'), '--engine', 'fake', '--spool', path.join(installDir, 'spool')]);
    expect(await agent.exited).toBe(0);
    expect(agent.output()).toMatch(/passed 1, failed 0/);
    expect(((await (await fetch(`${url}/cycles/b`)).json()) as { verdict: string }).verdict).toBe('verified');
    const resume = run('runner-agent.mjs', ['resume', '--help']);
    expect(await resume.exited).toBe(0);
    expect(resume.output()).toContain('사용법: sinclair-agent resume');
    const bogus = run('runner-agent.mjs', ['frobnicate']);
    expect(await bogus.exited).toBe(3);
    await cp.stop();
  });

  it('자산 경로: 번들의 헬퍼 APK 기본 위치는 <설치 디렉터리>/resources/helper 이고, 없으면 사유에 그 경로가 찍힌다(기기 접근 전)', async () => {
    const cp = run('control-plane.mjs', ['--port', '0', '--store', 'memory']);
    const url = `http://127.0.0.1:${await cp.ready()}`;
    await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'm', build: 'b', targets: ['android'] }) });
    const started = Date.now();
    const agent = run('runner-agent.mjs', ['run', '--control-plane', url, '--cycle', 'm', '--target', 'android', '--tests', path.join(installDir, 'tests'), '--engine', 'mobile', '--spool', path.join(installDir, 'spool'), '--helper-cache', path.join(installDir, 'cache')],
      { SINCLAIR_AGENT_HELPER_APK: '', SINCLAIR_AGENT_HELPER_URL: '' });
    expect(await agent.exited).toBe(2);
    expect(Date.now() - started).toBeLessThan(10_000); // engines.ts APPROVAL_WAIT_MS(60초) USB 승인 대기에 들어가지 않았다
    expect(agent.output()).toMatch(/헬퍼 APK 없음\(기기 불가\)/);
    expect(agent.output()).toContain(path.join(installDir, 'resources', 'helper', 'sinclair-helper-'));
    expect(agent.output()).toMatch(/repo-build: 리포 빌드\(설치본에는 없음\) 없음/);
    await cp.stop();
  });
});
