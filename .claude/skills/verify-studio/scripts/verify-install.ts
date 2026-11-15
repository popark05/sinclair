// verify-studio 설치본(studio-packaging 04): `pnpm dist:studio` 의 .app 을 리포 밖 임시 폴더로 복사해 실제 사용자처럼 띄우고 증명한다.
//   - 리포·시스템 node 없이(PATH=/usr/bin:/bin) 작업 프로세스가 동봉 Node(dist.mjs NODE_VERSION)로 준비됨
//   - ~/.config/sinclair/env 형식 파일(SINCLAIR_ENV_FILE, 임시)의 ANTHROPIC_* 가 작업 프로세스까지 닿음(가짜 Claude API 가 그 키로 count_tokens 를 받음)
//   - 데몬이 떠 있으면 발견 파일로 기기 목록이 보임(없으면 건너뜀)
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
  for (const other of ['mac', 'mac-arm64'].map((d) => path.join(repo, 'release/studio', d, 'Sinclair Studio.app'))) if (fs.existsSync(other)) { try { execFileSync(LSREGISTER, ['-u', other], { stdio: 'ignore' }); } catch { /* 등록돼 있지 않음 */ } }
  execFileSync(LSREGISTER, ['-f', app]);
  const handler = execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var u=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("sinclair://open")); u.isNil() ? "" : u.path.js'], { encoding: 'utf8' }).trim();
  check('LaunchServices 가 sinclair:// 처리기로 이 설치본을 고름(Info.plist CFBundleURLSchemes)', fs.existsSync(handler) && fs.realpathSync(handler) === app, handler.replace(tmp, '<설치본>') || '처리기 없음');
  cleanups.push(() => { try { execFileSync(LSREGISTER, ['-u', app]); } catch { /* 이미 없음 */ } });
  const nodeVersion = (await import(path.join(repo, 'scripts/dist.mjs'))).NODE_VERSION as string;

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
