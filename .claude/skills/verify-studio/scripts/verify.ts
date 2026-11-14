// verify-studio: 빌드된 Studio(Electron)를 Playwright _electron 으로 실제로 띄워 사용자 경로를 끝까지 구동하고 증거를 남긴다.
//   기기 화면(스냅샷) → 화면 클릭 = 탭 + Inspector 노드 선택·하이라이트·locator 후보 → 트리 검색 → 에이전트 세션(턴·결과) → 지금 화면 판정
//   → 내보내기(자연어·결정적, 복사 = 클립보드) → 녹화 캐시에 저장 → 내보낸 테스트를 실제로 돌려 통과(자연어는 녹화 재생으로 모델 0회).
// 모드:
//   기본(fake): 가짜 기기 서버(로그인 → 환영 화면, 실제 PNG) + 가짜 Claude API(ANTHROPIC_BASE_URL) + 메모리 control-plane. 기기·키 불필요.
//     내보낸 테스트는 runTests 로 같은 가짜 기기에서 돈다(engine-mobile + HTTP 녹화 저장소).
//   --device: 실기기. 데몬(sinclair-agent daemon, 발견 파일로 디바이스 RPC 공개)이 떠 있어야 하고 ~/.config/sinclair/env 의 실제 키를 쓴다.
//     내보낸 테스트는 Cycle 로 등록해 그 데몬이 돌린다. 화면에 개인정보가 보일 수 있어 스크린샷을 남기지 않는다.
// 사용: node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify.ts [--no-build] [--device] [--control-plane URL] [--app ID] [--goal 문장] [--judge 문장]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createDeviceServer, serveHttp, type DeviceBackend, type DeviceInfo, type Point } from '../../../../packages/device-layer/src/index.ts';
import { createMobileEngine, rpcOverHttp } from '../../../../packages/engine-mobile/src/index.ts';
import { createClaudeExecutor } from '../../../../packages/agent/src/index.ts';
import { runTests } from '../../../../packages/runner/src/index.ts';
import { createHttpCacheStore } from '../../../../apps/runner-agent/src/cache-store.ts';
import type { SemanticNode, RunEvent } from '../../../../packages/protocol/src/index.ts';

const repo = path.resolve(import.meta.dirname, '../../../..');
const studioDir = path.join(repo, 'apps/studio');
const studioRequire = createRequire(path.join(studioDir, 'package.json'));
const { _electron: electron } = studioRequire('playwright-core') as typeof import('playwright-core');
const electronBin = studioRequire('electron') as unknown as string;

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const opt = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DEVICE = flag('--device');
const evidenceFile = path.join(repo, '.scratch/studio/evidence', DEVICE ? 'verify-studio-device-latest.json' : 'verify-studio-latest.json');
const shotDir = path.join(repo, '.e2e/verify-studio');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-studio-'));
const cleanups: Array<() => Promise<void> | void> = [];
const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string): void => { checks.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────── 가짜 기기: 로그인 화면(아이디·비밀번호·로그인 버튼) → 로그인 탭 → 환영 화면 ─────────────
const W = 1080, H = 2400;
type Box = { x: number; y: number; width: number; height: number };
/** RGB PNG: 배경 + 사각형들(노드 위치가 화면에서 보이게) */
function png(bg: [number, number, number], boxes: Array<{ r: Box; c: [number, number, number] }>): Buffer {
  const row = Buffer.alloc(1 + W * 3);
  const raw = Buffer.alloc((1 + W * 3) * H);
  for (let y = 0; y < H; y++) {
    row[0] = 0;
    for (let x = 0; x < W; x++) {
      const b = boxes.find(({ r }) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
      const c = b ? b.c : bg;
      row[1 + x * 3] = c[0]; row[2 + x * 3] = c[1]; row[3 + x * 3] = c[2];
    }
    row.copy(raw, y * row.length);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(b: Buffer): number {
  let c = ~0;
  for (const byte of b) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}
const R = { title: { x: 0, y: 160, width: W, height: 120 }, user: { x: 80, y: 520, width: 920, height: 160 }, pass: { x: 80, y: 760, width: 920, height: 160 }, login: { x: 80, y: 1040, width: 920, height: 160 }, logout: { x: 80, y: 1040, width: 920, height: 160 } };

class FakePhone implements DeviceBackend {
  readonly platform = 'android' as const;
  readonly id = 'VERIFYSTUDIO01';
  calls: string[] = [];
  private screen: 'login' | 'home' = 'login';
  private user = '';
  private pass = '';
  private focus: 'user' | 'pass' | undefined;
  private readonly pngs = {
    login: png([245, 245, 245], [{ r: R.title, c: [220, 220, 230] }, { r: R.user, c: [255, 255, 255] }, { r: R.pass, c: [255, 255, 255] }, { r: R.login, c: [40, 90, 200] }]).toString('base64'),
    home: png([235, 250, 235], [{ r: R.title, c: [190, 230, 190] }, { r: R.logout, c: [200, 60, 60] }]).toString('base64'),
  };
  reset(): void { this.screen = 'login'; this.user = ''; this.pass = ''; this.focus = undefined; }
  tree(): SemanticNode {
    if (this.screen === 'home') return { ref: '@h0', role: 'root', rect: { x: 0, y: 0, width: W, height: H }, children: [
      { ref: '@h1', role: 'text', text: '환영합니다', testId: 'com.verify.app:id/welcome', rect: R.title },
      { ref: '@h2', role: 'button', name: '로그아웃', testId: 'com.verify.app:id/logout', rect: R.logout },
    ] };
    return { ref: '@e0', role: 'root', rect: { x: 0, y: 0, width: W, height: H }, children: [
      { ref: '@e1', role: 'text', text: 'Verify 로그인', testId: 'com.verify.app:id/title', rect: R.title },
      { ref: '@e2', role: 'textbox', testId: 'com.verify.app:id/username', placeholder: '아이디', ...(this.user ? { value: this.user } : {}), rect: R.user, ...(this.focus === 'user' ? { states: { focused: true } } : {}) },
      { ref: '@e3', role: 'textbox', testId: 'com.verify.app:id/password', placeholder: '비밀번호', ...(this.pass ? { value: this.pass } : {}), rect: R.pass, states: { secure: true, ...(this.focus === 'pass' ? { focused: true } : {}) } },
      { ref: '@e4', role: 'button', name: '로그인', rect: R.login },
    ] };
  }
  async listDevices(): Promise<DeviceInfo[]> { return [{ id: this.id, platform: 'android', model: 'VerifyFake', osVersion: '14', state: 'device' }]; }
  async info() { return (await this.listDevices())[0]!; }
  async screenshot() { return Buffer.from(this.pngs[this.screen], 'base64'); }
  async dumpUi() { return this.tree(); }
  async snapshot() { return { screenshot: { format: 'png' as const, base64: this.pngs[this.screen] }, root: this.tree(), atomic: true, capturedAt: new Date().toISOString() }; }
  async tap(_id: string, p: Point) {
    this.calls.push(`tap ${p.x},${p.y}`);
    const inside = (r: Box) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
    if (this.screen === 'home') { if (inside(R.logout)) this.reset(); return; }
    this.focus = inside(R.user) ? 'user' : inside(R.pass) ? 'pass' : undefined;
    if (inside(R.login)) this.screen = 'home';
  }
  async longPress(_id: string, p: Point) { this.calls.push(`longpress ${p.x},${p.y}`); }
  async swipe(_id: string, a: Point, b: Point) { this.calls.push(`swipe ${a.x},${a.y}->${b.x},${b.y}`); }
  async text(_id: string, t: string) { this.calls.push(`text ${t.length}자`); if (this.focus === 'user') this.user += t; else if (this.focus === 'pass') this.pass += t; }
  async keys(_id: string, k: string[]) { this.calls.push(`keys ${k.join('+')}`); }
  async button(_id: string, b: string) { this.calls.push(`button ${b}`); }
  async launchApp(_id: string, a: string) { this.calls.push(`launch ${a}`); this.reset(); }
  async terminateApp(_id: string, a: string) { this.calls.push(`terminate ${a}`); }
  async openUrl(_id: string, u: string) { this.calls.push(`url ${u}`); }
}

// ───────────── 가짜 Claude API: 화면을 보고 아이디 입력 → 로그인 탭 → done, 판정은 "환영합니다" 가 보이면 참 ─────────────
interface FakeApi { baseURL: string; actCalls: number; judgeCalls: number; close(): Promise<void> }
async function fakeClaude(): Promise<FakeApi> {
  const api = { actCalls: 0, judgeCalls: 0 } as FakeApi;
  const textOf = (m: { content: unknown }): string => typeof m.content === 'string' ? m.content : (m.content as Array<{ type: string; text?: string; content?: unknown }>).map((b) => b.text ?? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''))).join('\n');
  const reply = (content: unknown[], stop: string) => ({ id: 'msg_verify', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 }, content });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url?.includes('count_tokens')) return send({ input_tokens: 1 });
      const body = JSON.parse(raw) as { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> };
      const screen = textOf(body.messages.at(-1)!);
      const home = screen.includes('"환영합니다"');
      if (!body.tools?.length) {
        api.judgeCalls++;
        return send(reply([{ type: 'text', text: JSON.stringify({ pass: home, reason: home ? '"환영합니다" 문구가 보인다' : '로그인 화면이다' }) }], 'end_turn'));
      }
      api.actCalls++;
      const lines = screen.split('\n');
      const last = (re: RegExp) => [...lines].reverse().find((l) => re.test(l));
      const user = last(/id=com\.verify\.app:id\/username/);
      const call = home ? { name: 'done', input: { summary: '"환영합니다" 화면이 보인다' } }
        : user && !/value="qa"/.test(user) ? { name: 'type', input: { ref: /(@\w+)/.exec(user)![1], text: 'qa' } }
        : { name: 'tap', input: { ref: /(@\w+)/.exec(last(/button "로그인"/) ?? '@e4')![1] } };
      send(reply([{ type: 'text', text: `${call.name} 한다` }, { type: 'tool_use', id: `toolu_${api.actCalls}`, ...call }], 'tool_use'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return api;
}

async function startControlPlane(): Promise<string> {
  const cp: ChildProcess = spawn(process.execPath, [path.join(repo, 'apps/control-plane/bin/sinclair-control-plane.mjs'), '--port', '0', '--store', 'memory'], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => { cp.kill('SIGTERM'); });
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`control-plane READY 대기 초과: ${out}`)), 30_000);
    const on = (d: Buffer) => { out += d; const m = /READY .*port=(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } };
    cp.stdout!.on('data', on); cp.stderr!.on('data', on);
    cp.on('exit', (code) => { clearTimeout(t); reject(new Error(`control-plane 이 READY 전에 종료(code ${code}): ${out}`)); });
  });
  return `http://127.0.0.1:${port}`;
}

function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return env;
}

async function main(): Promise<void> {
  if (!flag('--no-build')) {
    console.log('Studio 빌드…');
    const b = spawnSync('pnpm', ['--filter', '@sinclair/studio', 'build'], { cwd: repo, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('Studio 빌드 실패');
  }
  fs.mkdirSync(shotDir, { recursive: true });

  // 환경: 기기·모델·control-plane
  let phone: FakePhone | undefined;
  let fakeApi: FakeApi | undefined;
  let controlPlane: string;
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = opt('--app') ?? (DEVICE ? 'com.google.android.youtube' : 'com.verify.app');
  const goal = opt('--goal') ?? (DEVICE ? 'YouTube 앱에서 검색창에 "플로렌스 게랭 데뷔작" 을 입력해 검색하고 검색 결과 목록을 연다' : '아이디 칸에 qa 를 입력하고 로그인 버튼을 눌러 환영 화면을 연다');
  const statement = opt('--judge') ?? (DEVICE ? '검색 결과 목록이 열려 있다' : '환영 화면이 보인다');
  let discovery: { port: number; token: string };
  if (DEVICE) {
    Object.assign(env, loadEnvFile(path.join(os.homedir(), '.config/sinclair/env')));
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) throw new Error('--device: ~/.config/sinclair/env 에 Claude 자격 증명이 없음');
    controlPlane = opt('--control-plane') ?? 'http://127.0.0.1:4780';
    const file = env.SINCLAIR_DEVICE_RPC_FILE || path.join(os.homedir(), 'Library/Application Support/sinclair/device-rpc.json');
    if (!fs.existsSync(file)) throw new Error(`--device: 발견 파일 ${file} 이 없음 — sinclair-agent daemon 을 먼저 띄운다`);
    discovery = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    phone = new FakePhone();
    const srv = await serveHttp(createDeviceServer([phone]));
    cleanups.push(() => srv.close());
    discovery = { port: srv.port, token: srv.token };
    const file = path.join(tmp, 'device-rpc.json');
    fs.writeFileSync(file, JSON.stringify({ port: srv.port, token: srv.token, pid: process.pid, agentId: 'verify-studio', startedAt: new Date().toISOString() }), { mode: 0o600 });
    fakeApi = await fakeClaude();
    cleanups.push(() => fakeApi!.close());
    controlPlane = await startControlPlane();
    Object.assign(env, { SINCLAIR_DEVICE_RPC_FILE: file, ANTHROPIC_BASE_URL: fakeApi.baseURL, ANTHROPIC_API_KEY: 'verify-fake-key', SINCLAIR_AGENT_MODEL_RETRIES: '0' });
    delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_PROFILE;
  }
  const rpc = rpcOverHttp({ port: discovery.port, token: discovery.token });
  const deviceId = ((await rpc.call('devices.list', {})) as DeviceInfo[]).find((d) => d.state === 'device')?.id;
  if (!deviceId) throw new Error('쓸 수 있는 기기가 없음');
  if (DEVICE) { await rpc.call('device.apps.terminate', { deviceId, appId: app }); await rpc.call('device.apps.launch', { deviceId, appId: app }); await sleep(3_000); }

  // ───────────── Studio 띄우기 ─────────────
  const t0 = Date.now();
  const studio = await electron.launch({ executablePath: electronBin, args: [studioDir], cwd: studioDir, env });
  cleanups.unshift(() => studio.close().catch(() => {}));
  const win = await studio.firstWindow();
  const shot = async (name: string) => { if (!DEVICE) await win.screenshot({ path: path.join(shotDir, `${name}.png`) }); };
  await win.getByText('데몬', { exact: true }).waitFor({ timeout: 30_000 });
  check('작업 프로세스가 발견 파일로 디바이스 RPC 에 붙음(툴바 "데몬")', true);
  const screen = win.getByRole('img', { name: /^기기 화면/ });
  await screen.waitFor({ timeout: 30_000 });
  const natural = await screen.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
  check('기기 화면 스냅샷을 그림', natural.w > 0 && natural.h > 0, `${natural.w}×${natural.h}, 기동 ${Date.now() - t0}ms`);
  // 현재 앱: 기기에 앞 화면 앱을 묻고(fake 는 구현이 없어 화면 트리의 resource-id 로) 버튼 옆에 결과를 보인다
  await win.getByRole('button', { name: '현재 앱' }).click();
  const toolbarStatus = win.getByRole('status', { name: '툴바 상태' });
  await toolbarStatus.getByText(/현재 앱:|알 수 없음/).waitFor({ timeout: 15_000 });
  const fgText = await toolbarStatus.innerText();
  check('현재 앱 버튼이 앞 화면 앱을 채우고 버튼 옆에 결과', fgText.includes(`현재 앱: ${app}`), fgText);
  await win.getByLabel('Studio 툴바').getByPlaceholder('com.example.app').fill(app);

  // 화면 클릭 = 탭 + 그 자리 노드 선택(Inspector 하이라이트·locator 후보)
  const box = (await screen.boundingBox())!;
  const fitK = Math.min(box.width / natural.w, box.height / natural.h);
  const ox = box.x + (box.width - natural.w * fitK) / 2, oy = box.y + (box.height - natural.h * fitK) / 2;
  const target = DEVICE ? { x: natural.w / 2, y: natural.h * 0.06 } : { x: R.user.x + R.user.width / 2, y: R.user.y + R.user.height / 2 };
  const tapsBefore = phone?.calls.filter((c) => c.startsWith('tap')).length ?? 0;
  await win.mouse.click(ox + target.x * fitK, oy + target.y * fitK);
  await win.getByLabel('선택한 노드 영역').waitFor({ timeout: 10_000 });
  check('화면 클릭 → 그 자리 노드 하이라이트', true);
  if (phone) {
    const tap = phone.calls.filter((c) => c.startsWith('tap'))[tapsBefore];
    const [x, y] = (tap ?? '').slice(4).split(',').map(Number);
    check('화면 클릭이 기기 픽셀 좌표 탭으로 감(여백·배율 변환)', tap !== undefined && Math.abs(x! - target.x) <= 3 && Math.abs(y! - target.y) <= 3, tap ?? '탭 없음');
  }
  const candidates = win.getByRole('list', { name: 'locator 후보' });
  await win.getByRole('radio', { name: '속성' }).or(win.getByRole('tab', { name: '속성' })).or(win.getByText('속성', { exact: true })).first().click();
  await candidates.waitFor({ timeout: 10_000 });
  const candText = await candidates.innerText();
  if (phone) check('고른 입력칸의 locator 후보(testId 우선)', candText.includes("getByTestId('com.verify.app:id/username')"), candText.split('\n')[0]);
  else check('고른 노드의 locator 후보 목록', candText.length > 0);
  await shot('01-inspector');

  if (phone) {
    await win.getByText('화면 트리', { exact: true }).first().click();
    await win.getByPlaceholder('역할·이름·testId').fill('로그인');
    await win.getByText(/button.*로그인/).first().click();
    await win.getByText('속성', { exact: true }).first().click();
    const t = await candidates.innerText();
    check('트리 검색 → 노드 선택 → 역할+이름 locator', /getByRole\('button', \{ name: '로그인'/.test(t), t.split('\n')[0]);
  }

  // ───────────── 에이전트 세션 ─────────────
  const ready = win.getByText(/^모델 /);
  await ready.waitFor({ timeout: 30_000 });
  check('에이전트 준비 점검(count_tokens) 통과', true, await ready.innerText());
  // 세션은 앱의 처음 화면에서 시작한다(studio 08 "앱 처음부터 시작", 앱 id 가 있으면 기본 켬): 내보낸 테스트가 app.restart 로
  // 그 화면에서 시작하므로 녹화의 첫 대상이 맞아야 재생된다. 위 Inspector 검사의 화면 클릭이 실제 탭이라 화면을 바꿔 놓았다
  const fresh = win.getByRole('checkbox', { name: '앱 처음부터 시작' });
  check('"앱 처음부터 시작" 이 기본으로 켜짐(툴바 앱 id)', await fresh.isChecked());
  const goalBox = win.getByLabel('목표');
  await goalBox.fill(goal);
  await win.getByRole('button', { name: '실행' }).click();
  const out = win.getByRole('status', { name: '세션 결과' }).or(win.locator('output[aria-label="세션 결과"]'));
  await out.first().waitFor({ timeout: DEVICE ? 180_000 : 30_000 });
  const resultText = await out.first().innerText();
  const turnItems = await win.getByRole('list', { name: '턴' }).getByRole('listitem').allInnerTexts();
  check('세션 성공(턴 타임라인 + 결과)', resultText.startsWith('성공'), `${resultText.replace(/\s+/g, ' ').slice(0, 120)} | 턴: ${turnItems.map((s) => s.split('\n')[0]).join(' / ')}`);
  await shot('02-session');

  await win.getByPlaceholder(/지금 화면에서 참이어야 할 문장/).fill(statement);
  await win.getByRole('button', { name: '판정', exact: true }).click();
  const judged = win.getByRole('list', { name: '판정' }).getByRole('listitem').first();
  await judged.waitFor({ timeout: DEVICE ? 60_000 : 15_000 });
  const judgedText = await judged.innerText();
  check('지금 화면 판정 = 참', judgedText.startsWith('참'), judgedText.split('\n')[0]);

  // 요소 판정(studio 09): 트리 검색으로 노드를 고르고(화면 탭 없이) "보인다" 를 모델 없이 판정
  await win.getByText('화면 트리', { exact: true }).first().click();
  await win.getByPlaceholder('역할·이름·testId').fill(DEVICE ? 'search_query' : '환영');
  await win.getByText(DEVICE ? /· search_query/ : /text "환영합니다"/).first().click();
  const fakeJudgeBefore = fakeApi?.judgeCalls ?? 0;
  await win.getByRole('button', { name: '요소 판정' }).click();
  const elementItem = win.getByRole('list', { name: '판정' }).getByRole('listitem').nth(1);
  await elementItem.waitFor({ timeout: 15_000 });
  const elementText = (await elementItem.innerText()).split('\n')[0]!;
  check('요소 판정 = 통과(고른 노드 · 보인다, 모델 없음)', /^통과 · expect\(screen\.getBy\w+\(.*\)\)\.toBeVisible\(\)$/.test(elementText) && (fakeApi?.judgeCalls ?? 0) === fakeJudgeBefore, elementText);

  // ───────────── 내보내기 ─────────────
  const exportPanel = win.getByRole('region', { name: '코드로 내보내기' }).or(win.locator('section[aria-label="코드로 내보내기"]')).first();
  await exportPanel.waitFor({ timeout: 10_000 });
  check('처음부터 시작한 세션이라 내보내기 경고 없음', await exportPanel.getByText(/앱 처음 화면에서 시작하지 않은 세션/).count() === 0);
  const testName = `Studio 검증 ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  await exportPanel.getByPlaceholder('테스트 이름').fill(testName);
  const copy = async (): Promise<string> => {
    await exportPanel.getByRole('button', { name: '복사' }).click();
    await exportPanel.getByText('클립보드에 복사함').waitFor({ timeout: 5_000 });
    return studio.evaluate(({ clipboard }) => clipboard.readText());
  };
  const naturalCode = await copy();
  check('자연어 내보내기(app.restart + act + assert), 복사 = 클립보드', naturalCode.includes(`await app.restart('${app}')`) && naturalCode.includes('await agent.act(') && naturalCode.includes(`await agent.assert(`), `${naturalCode.split('\n').length}줄`);
  await exportPanel.getByPlaceholder('control-plane 주소').or(exportPanel.getByLabel('control-plane 주소')).first().fill(controlPlane);
  await exportPanel.getByRole('button', { name: '녹화 캐시에 저장' }).click();
  const saved = exportPanel.getByText(/녹화 캐시에 저장함|녹화 저장 실패/);
  await saved.waitFor({ timeout: 15_000 });
  const savedText = await saved.innerText();
  check('녹화 캐시에 저장(control-plane PUT /cache)', savedText.startsWith('녹화 캐시에 저장함'), savedText);
  await shot('03-export-natural');
  await exportPanel.getByText('결정적', { exact: true }).click();
  // 같은 suite 에 같은 이름(testId)이 둘이면 Cycle 셀이 하나로 합쳐진다: 결정적은 이름을 달리한다(이름 입력도 구동)
  await exportPanel.getByPlaceholder('테스트 이름').fill(`${testName} · 결정적`);
  await sleep(300);
  const detCode = await copy();
  check('결정적 내보내기에 요소 판정이 expect 코드로', detCode.includes(`  await ${elementText.replace(/^통과 · /, '')};`), elementText.replace(/^통과 · /, ''));
  check('결정적 내보내기(app.restart + locator 코드, 이름 바꿈)', detCode.includes(`await app.restart('${app}')`) && detCode.includes('screen.get') && detCode.includes(`${testName} · 결정적`), detCode.split('\n').filter((l) => l.includes('screen.get')).map((l) => l.trim()).join(' | ').slice(0, 200));
  await shot('04-export-deterministic');
  await studio.close();
  cleanups.shift();

  // ───────────── 내보낸 테스트 실행 ─────────────
  const suite = DEVICE ? path.join(repo, '.e2e/verify-studio-suite') : path.join(tmp, 'suite');
  fs.rmSync(suite, { recursive: true, force: true });
  fs.mkdirSync(suite, { recursive: true });
  // 내보낸 코드는 `@sinclair/runner` 를 import 한다: 실기 suite 는 데몬이 리포 체크아웃에서 풀고, fake 는 러너 소스로 바꿔 쓴다
  const fix = (code: string) => DEVICE ? code : code.replace("from '@sinclair/runner'", `from ${JSON.stringify(path.join(repo, 'packages/runner/src/index.ts'))}`);
  fs.writeFileSync(path.join(suite, '01-natural.sinclair.ts'), fix(naturalCode));
  fs.writeFileSync(path.join(suite, '02-deterministic.sinclair.ts'), fix(detCode));
  // 데몬이 테스트 파일의 `@sinclair/runner` 를 자기 runner 로 넘긴다(리포 체크아웃·설치본 모두 resolve 훅, studio-console 01) — 링크 불필요

  if (!DEVICE) {
    const events: RunEvent[] = [];
    const actBefore = fakeApi!.actCalls;
    const report = await runTests([path.join(suite, '01-natural.sinclair.ts'), path.join(suite, '02-deterministic.sinclair.ts')], {
      engine: createMobileEngine(rpc, { deviceId }),
      timeoutMs: 5_000,
      agent: { executor: createClaudeExecutor({ baseURL: fakeApi!.baseURL, apiKey: 'verify-fake-key', maxRetries: 0 }) },
      cache: { store: createHttpCacheStore(controlPlane), mode: 'read-write' },
      reporter: { onEvent: (e: RunEvent) => { events.push(e); } },
    });
    const results = report.tests.map((t) => `${t.name}=${t.result}`);
    check('내보낸 두 테스트가 같은 기기에서 통과', report.tests.length === 2 && report.tests.every((t) => t.result === 'passed'), results.join(', '));
    const acts = events.filter((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded').filter((s) => (s as { kind?: string }).kind === 'act');
    check('자연어 act 는 Studio 가 저장한 녹화로 재생(act 모델 0회)', fakeApi!.actCalls === actBefore && acts.length === 1 && (acts[0] as { cache?: string }).cache === 'replayed', `act 스텝 cache=${(acts[0] as { cache?: string } | undefined)?.cache} · act 모델 호출 ${fakeApi!.actCalls - actBefore}`);
  } else {
    const cycleId = `verify-studio-${Date.now()}`;
    const post = (p: string, body: unknown) => fetch(`${controlPlane}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await rpc.call('device.apps.terminate', { deviceId, appId: app });
    await post('/cycles', { cycleId, build: 'verify-studio', targets: [{ id: 'android-real', platform: 'android' }], suite: { tests: suite } });
    await post(`/cycles/${cycleId}/runs`, { targetId: 'android-real' });
    let cycle: { state: string; verdict: string; runs: Array<{ runId: string }> } | undefined;
    for (let i = 0; i < 200; i++) { cycle = await (await fetch(`${controlPlane}/cycles/${cycleId}`)).json() as typeof cycle; if (cycle?.state === 'finished') break; await sleep(3_000); }
    const run = await (await fetch(`${controlPlane}/runs/${cycle!.runs[0]!.runId}`)).json() as { attempts: Array<{ testId: string; result: string; steps: Array<{ kind: string; cache?: string; modelCalls: number }> }> };
    check('데몬이 내보낸 두 테스트를 Cycle 로 돌려 verified(둘 다 통과)', cycle?.verdict === 'verified' && run.attempts.length === 2 && run.attempts.every((a) => a.result === 'passed'), `Cycle ${cycleId} verdict=${cycle?.verdict} · ${run.attempts.map((a) => `${a.testId.endsWith('결정적') ? '결정적' : '자연어'}=${a.result}`).join(', ')}`);
    const nat = run.attempts.find((a) => !a.testId.endsWith('결정적'));
    const act = nat?.steps.find((s) => s.kind === 'act');
    check('자연어 act 는 Studio 가 저장한 녹화로 재생(모델 0회)', act?.cache === 'replayed' && act.modelCalls === 0, `cache=${act?.cache} calls=${act?.modelCalls}`);
  }
}

let failed = false;
try { await main(); } catch (err) { failed = true; console.error('중단:', err instanceof Error ? err.stack : err); checks.push({ name: '중단', ok: false, detail: err instanceof Error ? err.message : String(err) }); }
for (const c of cleanups) { try { await c(); } catch { /* 정리 실패는 무시 */ } }
fs.rmSync(tmp, { recursive: true, force: true });
const ok = !failed && checks.every((c) => c.ok);
fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
fs.writeFileSync(evidenceFile, JSON.stringify({ skill: 'verify-studio', mode: DEVICE ? 'device' : 'fake', at: new Date().toISOString(), ok, checks }, null, 2) + '\n');
console.log(`${ok ? 'OK' : 'FAILED'} ${checks.filter((c) => c.ok).length}/${checks.length} — 증거 ${path.relative(repo, evidenceFile)}`);
process.exit(ok ? 0 : 1);
