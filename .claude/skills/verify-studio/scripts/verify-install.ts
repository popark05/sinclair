// verify-studio 설치본(studio-packaging 04): `pnpm dist:studio` 의 .app 을 리포 밖 임시 폴더로 복사해 실제 사용자처럼 띄우고 증명한다.
//   - 리포·시스템 node 없이(PATH=/usr/bin:/bin) 작업 프로세스가 동봉 Node(dist.mjs NODE_VERSION)로 준비됨
//   - ~/.config/sinclair/env 형식 파일(SINCLAIR_ENV_FILE, 임시)의 ANTHROPIC_* 가 작업 프로세스까지 닿음(가짜 Claude API 가 그 키로 count_tokens 를 받음)
//   - 데몬이 떠 있으면 발견 파일로 기기 목록이 보임(없으면 건너뜀)
//   - 동봉 CLI: PATH 에 건 심링크로 control-plane(동봉 Console)·에이전트 FakeEngine run(리포 밖 테스트 폴더)
//   - 앱 아이콘, 자동 업데이트: 동봉 CLI control-plane 이 버전만 올린 같은 빌드를 배포 → 설치본이 알리고 누르면 바꿔 끼워 다시 뜸
//   - URL 스킴: macOS `open sinclair://open?request=<id>` 가 실행 중인 Studio 의 open-url 로 닿고, 열기 요청의 기기·목표가 채워짐(폴링 차례 전에)
// 화면에 개인정보가 보일 수 있어 스크린샷을 남기지 않는다. 증거: .scratch/studio-packaging/evidence/verify-install-latest.json
// 사용: node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify-install.ts [--no-build] [--control-plane http://127.0.0.1:4780]
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

const repo = path.resolve(import.meta.dirname, '../../../..');
const studioRequire = createRequire(path.join(repo, 'apps/studio/package.json'));
const { _electron: electron } = studioRequire('playwright-core') as typeof import('playwright-core');
const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const controlPlane = opt('--control-plane') ?? 'http://127.0.0.1:4780';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const built = path.join(repo, 'release/studio', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Sinclair Studio.app');
const evidenceFile = path.join(repo, '.scratch/studio-packaging/evidence/verify-install-latest.json');
// 설치본 복사본은 홈 아래(리포 밖)에: LaunchServices 는 /private/tmp·/var/folders 아래 앱을 URL 처리기로 고르지 않는다(실측)
const cacheRoot = path.join(os.homedir(), 'Library/Caches/sinclair-verify-install');
fs.mkdirSync(cacheRoot, { recursive: true });
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(cacheRoot, 'run-')));
const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string): void => { checks.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const cleanups: Array<() => Promise<void> | void> = [];
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

async function main(): Promise<void> {
  if (!argv.includes('--no-build')) {
    const r = spawnSync('node', ['scripts/dist-studio.mjs', '--targets', `mac-${arch}`, '--dir'], { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`설치본 빌드 실패:\n${r.stdout}\n${r.stderr}`);
  }
  if (!fs.existsSync(built)) throw new Error(`설치본이 없음: ${built} (--no-build 를 빼고 다시)`);
  const app = path.join(tmp, 'Sinclair Studio.app');
  execFileSync('ditto', [built, app]);
  // LaunchServices 에 이 복사본만 등록(설치와 같은 효과) — 리포의 빌드 산출물이 등록돼 있으면 open 이 그쪽을 새로 띄운다(검증 중 실제로 그랬다). 끝나면 지운다
  // 방금 만든 빌드는 LaunchServices 가 조금 뒤에 스스로 등록하기도 한다(빌드 직후 실행에서 처리기가 리포 빌드였다) — 우리 복사본이 처리기가 될 때까지 몇 번 다시
  const others = ['mac', 'mac-arm64'].map((d) => path.join(repo, 'release/studio', d, 'Sinclair Studio.app')).filter((o) => fs.existsSync(o));
  const urlHandler = (): string => execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var u=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("sinclair://open")); u.isNil() ? "" : u.path.js'], { encoding: 'utf8' }).trim();
  let handler = '';
  for (let i = 0; i < 6; i++) {
    for (const other of others) { try { execFileSync(LSREGISTER, ['-u', other], { stdio: 'ignore' }); } catch { /* 등록돼 있지 않음 */ } }
    execFileSync(LSREGISTER, ['-f', app]);
    handler = urlHandler();
    if (fs.existsSync(handler) && fs.realpathSync(handler) === app) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('LaunchServices 가 sinclair:// 처리기로 이 설치본을 고름(Info.plist CFBundleURLSchemes)', fs.existsSync(handler) && fs.realpathSync(handler) === app, handler.replace(tmp, '<설치본>') || '처리기 없음');
  cleanups.push(() => { try { execFileSync(LSREGISTER, ['-u', app]); } catch { /* 이미 없음 */ } });
  const nodeVersion = (await import(path.join(repo, 'scripts/dist.mjs'))).NODE_VERSION as string;
  // 아이콘(studio-update 01): Info.plist 가 가리키는 icns 가 리포의 apps/studio/build/icon.icns 와 같다
  const iconFile = execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const iconPath = path.join(app, 'Contents/Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`);
  check('앱 아이콘: Info.plist CFBundleIconFile 이 Sinclair 아이콘(Electron 기본 아님)', fs.existsSync(iconPath) && fs.readFileSync(iconPath).equals(fs.readFileSync(path.join(repo, 'apps/studio/build/icon.icns'))), iconFile);
  const releasesDir = makeUpdateRelease(app);
  const cliUrl = await cliChecks(app, nodeVersion, releasesDir);

  // 가짜 Claude API: env 파일의 키가 작업 프로세스까지 닿는지(헤더) 본다
  const seenKeys: string[] = [];
  const fake = http.createServer((req, res) => {
    seenKeys.push(String(req.headers['x-api-key'] ?? req.headers.authorization ?? ''));
    if (process.env.VERIFY_DEBUG) { const a = String(req.headers.authorization ?? ''); console.log('fake api', req.method, req.url, 'auth scheme', a.split(' ')[0], 'has test key', a.includes('sk-verify-install'), 'len', a.length); }
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 1 })); });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => fake.close(() => r())));
  const envFile = path.join(tmp, 'env');
  fs.writeFileSync(envFile, `export ANTHROPIC_API_KEY=sk-verify-install\nANTHROPIC_BASE_URL=http://127.0.0.1:${(fake.address() as AddressInfo).port}\nPATH=/should/not/pass\n`, { mode: 0o600 });

  const t0 = Date.now();
  const studio = await electron.launch({
    executablePath: path.join(app, 'Contents/MacOS/Sinclair Studio'), args: [], cwd: tmp,
    env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', SINCLAIR_STUDIO_USER_DATA: path.join(tmp, 'userdata'), SINCLAIR_ENV_FILE: envFile },
  });
  cleanups.unshift(() => studio.close().catch(() => {}));
  const win = await studio.firstWindow();
  const info = await studio.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath }));
  check('설치본으로 뜸(app.isPackaged, 리포 밖 Resources)', info.packaged && info.resources.startsWith(tmp) && !info.resources.startsWith(repo), info.resources.replace(tmp, '<tmp>'));
  const ready = win.getByText(/준비됨 · Node/);
  await ready.waitFor({ timeout: 30_000 });
  const readyText = await ready.innerText();
  check('작업 프로세스가 동봉 Node 로 준비됨(PATH 에 node 없음)', readyText.includes(`Node v${nodeVersion}`), `${readyText.replace(/pid \d+/, 'pid …')}, 기동 ${Date.now() - t0}ms`);
  for (let i = 0; i < 40 && !seenKeys.length; i++) await new Promise((r) => setTimeout(r, 250));
  check('env 파일의 ANTHROPIC_API_KEY·BASE_URL 이 작업 프로세스에 닿음(가짜 API 가 그 키로 받음)', seenKeys.some((k) => k.includes('sk-verify-install')), `요청 ${seenKeys.length}건`);

  // 기기: 데몬이 있으면 발견 파일로 붙는다
  const daemon = await win.getByText('데몬', { exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  let deviceId: string | undefined;
  if (daemon) {
    const devices = await fetch(`${controlPlane}/fleet`).then((r) => r.json() as Promise<{ nodes: Array<{ online: boolean; devices: Array<{ id: string; state: string }> }> }>).catch(() => undefined);
    deviceId = devices?.nodes.filter((n) => n.online).flatMap((n) => n.devices).find((d) => d.state === 'idle' || d.state === 'leased')?.id;
    check('데몬 발견 파일로 기기 RPC 에 붙음(툴바 "데몬")', true, deviceId ? `기기 …${deviceId.slice(-4)}` : '쓸 수 있는 기기 없음');
  } else console.log('SKIP 데몬이 없어 기기·URL 스킴 확인을 건너뜀');

  // URL 스킴: 열기 요청을 남기고 macOS 가 그 링크를 실행 중인 Studio 로 보낸다
  if (deviceId) {
    const goal = `설치본 URL 스킴 확인 ${Date.now() % 100000}`;
    const r = await fetch(`${controlPlane}/studio/open-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, goal, from: { cycleId: 'verify-install', testId: 'url-scheme', targetId: 'mac' } }) });
    const { id } = await r.json() as { id: string };
    // 리스너를 먼저 걸고(await) 링크를 연다 — 걸기 전에 열면 이벤트를 놓친다
    await studio.evaluate(({ app }) => { (globalThis as { __verifyLinks?: string[] }).__verifyLinks = []; app.on('open-url', (_e, u) => (globalThis as { __verifyLinks?: string[] }).__verifyLinks!.push(u)); });
    const t1 = Date.now();
    const opened = spawnSync('open', [`sinclair://open?request=${id}`], { encoding: 'utf8' });
    if (opened.status !== 0) console.log(`open 실패: ${opened.stderr.trim()}`);
    const box = win.getByLabel('목표');
    let filled = '';
    for (let i = 0; i < 40 && filled !== goal; i++) { filled = await box.inputValue().catch(() => ''); if (filled !== goal) await new Promise((r) => setTimeout(r, 100)); }
    const ms = Date.now() - t1;
    const links = await studio.evaluate(() => (globalThis as { __verifyLinks?: string[] }).__verifyLinks ?? []);
    check('macOS open sinclair:// 이 실행 중인 Studio 의 open-url 로 닿음(새 인스턴스 없음)', links.includes(`sinclair://open?request=${id}`), `${links.length}건`);
    // 폴링(3초) 차례를 기다리지 않았다: 링크 뒤 2초 안
    check('링크로 열기 요청의 목표가 채워지고 "Console 에서 열림"(폴링 차례 전에)', filled === goal && ms < 2_000 && await win.getByText(/Console 에서 열림/).first().isVisible(), `${ms}ms`);
  }
  // 콜드 스타트: Studio 가 꺼져 있을 때 링크가 앱을 띄우고, 뜬 Studio 가 그 요청을 받는다(ack 로 목록에서 빠짐)
  if (deviceId) {
    await studio.close();
    const r = await fetch(`${controlPlane}/studio/open-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, goal: '설치본 콜드 스타트 확인', from: { cycleId: 'verify-install', testId: 'cold-start', targetId: 'mac' } }) });
    const { id } = await r.json() as { id: string };
    const t2 = Date.now();
    // --env: 사용자 설정·데이터를 건드리지 않게 임시 userData 로(검증 훅은 단일 인스턴스 잠금도 끈다)
    execFileSync('open', ['--env', `SINCLAIR_STUDIO_USER_DATA=${path.join(tmp, 'userdata-cold')}`, '--env', `SINCLAIR_ENV_FILE=${envFile}`, `sinclair://open?request=${id}`]);
    let acked = false;
    for (let i = 0; i < 60 && !acked; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const left = await fetch(`${controlPlane}/studio/open-requests?devices=${encodeURIComponent(deviceId)}`).then((x) => x.json() as Promise<{ requests?: Array<{ id: string }> }>).catch(() => ({ requests: undefined }));
      acked = !!left.requests && !left.requests.some((x) => x.id === id);
    }
    const pids = spawnSync('pgrep', ['-f', `${app}/Contents/MacOS/Sinclair Studio`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    check('콜드 스타트: 꺼진 Studio 를 링크가 띄우고 그 요청을 받음(ack)', acked && pids.length > 0, `${Date.now() - t2}ms, 프로세스 ${pids.length}`);
    cleanups.unshift(() => { spawnSync('pkill', ['-f', `${app}/Contents/MacOS/Sinclair Studio`]); });
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* 이미 끝남 */ } }
    await new Promise((res) => setTimeout(res, 1500));
  }
  await studio.close().catch(() => {});
  spawnSync('pkill', ['-f', `${app}/Contents/MacOS/Sinclair Studio`]);
  await new Promise((res) => setTimeout(res, 1000));
  await updateChecks(app, cliUrl, envFile);
}

const UPDATE_VERSION = '99.0.0';
/** 업데이트 배포(studio-update 04): 같은 빌드의 Info.plist 버전만 올린 복사본을 zip 으로, dist:studio 와 같은 목록(releaseManifest) */
function makeUpdateRelease(app: string): string {
  const dir = path.join(tmp, 'releases');
  const work = path.join(tmp, 'release-work');
  fs.mkdirSync(dir); fs.mkdirSync(work);
  const copy = path.join(work, path.basename(app));
  execFileSync('ditto', [app, copy]);
  execFileSync('plutil', ['-replace', 'CFBundleShortVersionString', '-string', UPDATE_VERSION, path.join(copy, 'Contents/Info.plist')]);
  // Info.plist 를 바꾸면 ad-hoc 서명(arm64)이 깨진다 — 다시 ad-hoc 서명
  spawnSync('codesign', ['--force', '--deep', '-s', '-', copy]);
  const zip = path.join(dir, `Sinclair-Studio-${UPDATE_VERSION}-mac-${arch}.zip`);
  execFileSync('ditto', ['-c', '-k', '--keepParent', copy, zip]);
  fs.rmSync(work, { recursive: true, force: true });
  return dir;
}

/** 자동 업데이트(studio-update 04): 설치본이 control-plane 배포에서 새 버전을 알고, 누르면 받아 바꿔 끼운 뒤 같은 자리에서 다시 뜬다 */
async function updateChecks(app: string, cliUrl: string, envFile: string): Promise<void> {
  const { releaseManifest } = await import(path.join(repo, 'scripts/dist-studio.mjs')) as typeof import('../../../../scripts/dist-studio.mjs');
  const releasesDir = path.join(tmp, 'releases');
  const zip = fs.readdirSync(releasesDir).find((f) => f.endsWith('.zip'))!;
  fs.writeFileSync(path.join(releasesDir, 'latest-mac.json'), JSON.stringify(releaseManifest({ version: UPDATE_VERSION, zips: [{ arch, path: path.join(releasesDir, zip) }] })));
  const latest = await fetch(`${cliUrl}/studio/releases/latest?arch=${arch}`).then((r) => r.json() as Promise<{ version?: string }>);
  check('업데이트 배포: 동봉 CLI control-plane --studio-releases-dir 가 최신 버전을 알림', latest.version === UPDATE_VERSION, JSON.stringify(latest).slice(0, 120));
  const userData = path.join(tmp, 'userdata-update');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ controlPlane: cliUrl, testsDir: path.join(tmp, 'tests') }));
  const plist = path.join(app, 'Contents/Info.plist');
  const before = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8' }).trim();
  const studio = await electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Sinclair Studio'), args: [], cwd: tmp, env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', SINCLAIR_STUDIO_USER_DATA: userData, SINCLAIR_ENV_FILE: envFile } });
  const win = await studio.firstWindow();
  const t0 = Date.now();
  const button = win.getByRole('button', { name: `업데이트 ${UPDATE_VERSION}` });
  const shown = await button.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check('Studio 가 기동 뒤 스스로 새 버전을 확인해 툴바에 "업데이트 99.0.0"', shown, `${Date.now() - t0}ms, 현재 ${before}`);
  if (!shown) { await studio.close().catch(() => {}); return; }
  const oldPid = await studio.evaluate(() => process.pid);
  const t1 = Date.now();
  await button.click();
  let after = before;
  let pids: string[] = [];
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { after = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { continue; }
    pids = spawnSync('pgrep', ['-f', `${app}/Contents/MacOS/Sinclair Studio$`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).filter((p) => Number(p) !== oldPid);
    if (after === UPDATE_VERSION && pids.length) break;
  }
  cleanups.unshift(() => { spawnSync('pkill', ['-f', `${app}/Contents/MacOS/Sinclair Studio`]); });
  const swapLog = fs.existsSync(path.join(userData, 'updates/swap.log')) ? fs.readFileSync(path.join(userData, 'updates/swap.log'), 'utf8').trim() : '로그 없음';
  check('누르면 받아(sha256) 같은 자리의 앱을 99.0.0 으로 바꾸고 다시 띄움', after === UPDATE_VERSION && pids.length > 0 && !fs.existsSync(`${app}.updating-old`), `${Date.now() - t1}ms, Info.plist ${before} → ${after}, 새 프로세스 ${pids.length}, ${swapLog.replace(tmp, '<tmp>')}`);
  const cliAfter = spawnSync(path.join(tmp, 'path-bin', 'sinclair-agent'), ['--help'], { cwd: tmp, env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  check('교체 뒤에도 PATH 에 건 CLI 링크가 그대로 동작', cliAfter.status === 0, `종료 ${cliAfter.status}`);
}

/** 동봉 CLI(studio-packaging 05): PATH 에 건 심링크로 리포·시스템 node 없이 control-plane(동봉 Console)·에이전트 FakeEngine run 이 verified */
async function cliChecks(app: string, nodeVersion: string, releasesDir: string): Promise<string> {
  const binDir = path.join(tmp, 'path-bin');
  fs.mkdirSync(binDir);
  for (const b of ['sinclair-agent', 'sinclair-control-plane']) fs.symlinkSync(path.join(app, 'Contents/Resources/cli/bin', b), path.join(binDir, b));
  const env = { HOME: os.homedir(), PATH: `${binDir}:/usr/bin:/bin` };
  const version = spawnSync('sinclair-agent', ['--help'], { cwd: tmp, env, encoding: 'utf8' });
  check('CLI: PATH 의 심링크 sinclair-agent --help(시스템 node 없음)', version.status === 0 && /daemon/.test(version.stdout + version.stderr), `종료 ${version.status}`);
  const port = await new Promise<number>((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
  const { spawn } = await import('node:child_process');
  const cp = spawn('sinclair-control-plane', ['--store', 'memory', '--port', String(port), '--studio-releases-dir', releasesDir], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => { cp.kill('SIGTERM'); });
  let log = ''; cp.stdout.on('data', (d) => { log += d; }); cp.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  let consoleOk = false;
  for (let i = 0; i < 50 && !consoleOk; i++) { try { const r = await fetch(`${url}/console/`); consoleOk = r.status === 200 && (await r.text()).includes('<div id="root"'); } catch { await new Promise((r) => setTimeout(r, 200)); } }
  check('CLI: control-plane 이 동봉 Console(Resources/console)을 /console 에서 서빙', consoleOk, consoleOk ? `Node v${nodeVersion}` : log.slice(-300));
  const tests = path.join(tmp, 'cli-tests');
  fs.mkdirSync(tests);
  fs.writeFileSync(path.join(tests, 'login.sinclair.ts'), "import { test } from '@sinclair/runner';\ntest('로그인', async ({ screen, expect }) => { await screen.getByRole('button', { name: '로그인' }).tap(); await expect(screen.getByText('환영합니다')).toBeVisible(); });\n");
  const cycle = `studio-cli-${Date.now()}`;
  await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: cycle, build: 'verify', targets: ['android'] }) });
  const run = spawnSync('sinclair-agent', ['run', '--control-plane', url, '--cycle', cycle, '--target', 'android', '--tests', tests, '--engine', 'fake', '--spool', path.join(tmp, 'cli-spool')], { cwd: tmp, env, encoding: 'utf8', timeout: 60_000 });
  const view = await (await fetch(`${url}/cycles/${cycle}`)).json() as { verdict?: string; state?: string };
  check('CLI: 리포 밖 테스트 폴더의 @sinclair/runner 를 풀어 FakeEngine run → Cycle verified', run.status === 0 && view.verdict === 'verified', `종료 ${run.status}, ${view.state}/${view.verdict}${run.status === 0 ? '' : ` ${(run.stderr || run.stdout).slice(-300)}`}`);
  return url;
}

try { await main(); } catch (err) { check('예외 없이 끝남', false, err instanceof Error ? err.message : String(err)); }
finally {
  for (const c of cleanups) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.rmdirSync(cacheRoot); } catch { /* 다른 실행이 쓰는 중 */ }
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify({ at: new Date().toISOString(), arch, checks, passed: checks.filter((c) => c.ok).length, total: checks.length }, null, 2));
  console.log(`${checks.filter((c) => c.ok).length}/${checks.length} — ${path.relative(repo, evidenceFile)}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
