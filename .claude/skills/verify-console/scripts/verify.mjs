#!/usr/bin/env node
// verify-console: 실제 control-plane(리포 bin, --console-dir) + 가짜 엔진 에이전트로 Cycle 을 채우고, 헤드리스 Chrome 으로 Console 화면 다섯 개를 연다.
// 화면마다 렌더된 DOM 에 기대 문구가 있는지 보고, 스크린샷을 .e2e/verify-console/ 에, 판정을 .scratch/console/evidence/verify-console-latest.json 에 남긴다.
//   node .claude/skills/verify-console/scripts/verify.mjs [--no-build]
// Chrome: CHROME 환경변수, 없으면 macOS 기본 경로. 없으면 건너뛴다(종료 코드 3).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chrome)) { console.log(`건너뜀: Chrome 이 없음(${chrome}) — CHROME 환경변수로 지정`); process.exit(3); }
const shots = path.join(repo, '.e2e', 'verify-console');
const evidence = path.join(repo, '.scratch', 'console', 'evidence', 'verify-console-latest.json');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.dirname(evidence), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-console-'));

if (!process.argv.includes('--no-build')) {
  const b = spawnSync('pnpm', ['--filter', '@sinclair/console', 'build'], { cwd: repo, encoding: 'utf8' });
  if (b.status !== 0) { console.error(b.stdout, b.stderr); process.exit(1); }
}

// 1) control-plane
const cp = spawn(process.execPath, [path.join(repo, 'apps/control-plane/bin/sinclair-control-plane.mjs'), '--port', '0', '--store', 'memory', '--console-dir', path.join(repo, 'apps/console/dist')], { stdio: ['ignore', 'pipe', 'pipe'] });
let cpOut = '';
cp.stdout.on('data', (d) => { cpOut += d; }); cp.stderr.on('data', (d) => { cpOut += d; });
const results = [];
try {
  // 기동 대기도 try 안: 실패해도 아래 finally 가 서버·임시 디렉터리를 정리한다. 일찍 죽으면 30초를 기다리지 않는다
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`control-plane READY 대기 초과: ${cpOut}`)), 30_000);
    cp.on('exit', (code) => { clearTimeout(t); reject(new Error(`control-plane 이 READY 전에 종료(code ${code}): ${cpOut}`)); });
    const check = () => { const m = /READY .*port=(\d+)/.exec(cpOut); if (m) { clearTimeout(t); resolve(Number(m[1])); } };
    cp.stdout.on('data', check);
  });
  const base = `http://127.0.0.1:${port}`;
  // 2) Cycle + 가짜 에이전트 run(통과 1·실패 1) + 노드 보고
  const cycleId = `verify-${Date.now()}`;
  await fetch(`${base}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId, build: 'verify-1.0', targets: ['android'] }) });
  const agent = spawnSync(process.execPath, [path.join(repo, 'apps/runner-agent/bin/sinclair-agent.mjs'), 'run', '--control-plane', base, '--cycle', cycleId, '--target', 'android', '--tests', path.join(repo, 'apps/runner-agent/test/fixtures'), '--engine', 'fake', '--timeout', '300', '--spool', path.join(tmp, 'spool'), '--agent', 'verify-node'], { encoding: 'utf8' });
  if (agent.status !== 1) throw new Error(`에이전트 종료 코드 ${agent.status}(실패 1개라 1 이어야 함): ${agent.stdout}${agent.stderr}`);
  await fetch(`${base}/fleet/nodes/verify-node`, { method: 'PUT', body: JSON.stringify({ devices: [{ id: 'FAKE00001234', platform: 'android', model: 'FakeEngine', osVersion: '0', connection: 'device', helper: 'ready', locked: false }] }) });
  const view = await (await fetch(`${base}/cycles/${cycleId}`)).json();
  const failing = Object.keys(view.matrix).find((t) => view.matrix[t].android?.verdict === 'failed');
  if (!failing) throw new Error(`실패 케이스가 매트릭스에 없음: ${JSON.stringify(view.matrix)}`);
  // 에이전트가 실패 스냅샷을 올렸다(기본 켜짐): 스크린샷 바이트를 서버가 준다
  const runView = await (await fetch(`${base}/runs/${view.runs[0].runId}`)).json();
  const shotKey = runView.attempts.flatMap((a) => a.artifacts).find((a) => a.kind === 'screenshot')?.key;
  const shotRes = shotKey ? await fetch(`${base}/artifacts/${view.runs[0].runId}/${shotKey}`) : undefined;
  results.push({ page: 'artifact', path: '/artifacts/<run>/<key>', ok: shotRes?.status === 200 && shotRes.headers.get('content-type') === 'image/png', checks: [{ text: 'screenshot 업로드·서빙', found: shotRes?.status === 200 }] });

  // 3) 화면들: 렌더된 DOM(가상 시간 예산 동안 fetch·렌더가 끝난다)과 스크린샷
  const pages = [
    { name: 'cycles', path: '/console/', expect: ['verify-1.0', '끝남'] },
    // 셀 클래스로 판정한다(머리말·범례의 '실패'·'통과' 글자는 매트릭스가 비어도 늘 있다)
    { name: 'cycle', path: `/console/cycles/${cycleId}`, expect: ['class="cell cell-failed"><a', 'class="cell cell-passed"><a', 'verify-node', '…fake'] },
    { name: 'case', path: `/console/cycles/${cycleId}/cases/${encodeURIComponent(failing)}/android`, expect: ['시도 1', 'not-found', 'locator', '→ 실패', '이 테스트의 이력', 'alt="시도 1 의 마지막 화면"', '.screen-tree.json</a>'] },
    { name: 'fleet', path: '/console/fleet', expect: ['verify-node', '온라인', '…1234', '쓸 수 있음'], absent: ['FAKE00001234'] }, // 원시 시리얼은 화면에 없다
    { name: 'tests', path: '/console/tests', expect: [failing, 'spark cell-failed', 'spark cell-passed'] },
  ];
  for (const p of pages) {
    const url = `${base}${p.path}`;
    const common = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(tmp, `chrome-${p.name}`)}`, '--virtual-time-budget=8000', '--window-size=1280,900'];
    const dom = execFileSync(chrome, [...common, '--dump-dom', url], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const shot = path.join(shots, `${p.name}.png`);
    execFileSync(chrome, [...common, `--screenshot=${shot}`, url], { timeout: 60_000, stdio: 'ignore' });
    const checks = [...p.expect.map((text) => ({ text, found: dom.includes(text) })), ...(p.absent ?? []).map((text) => ({ text: `없음: ${text}`, found: !dom.includes(text) }))];
    const error = /role="alert"[^>]*>([^<]*)/.exec(dom)?.[1];
    results.push({ page: p.name, path: p.path.replace(cycleId, '<cycle>'), ok: checks.every((c) => c.found) && !error, checks, ...(error ? { error } : {}), screenshot: path.relative(repo, shot), screenshotBytes: fs.statSync(shot).size });
  }
} finally {
  cp.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
const ok = results.length === 6 && results.every((r) => r.ok);
fs.writeFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), ok, chrome: path.basename(chrome), pages: results }, null, 2) + '\n');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.page} ${r.checks.map((c) => `${c.found ? '✓' : '✗'}${c.text}`).join(' ')}${r.error ? ` 오류: ${r.error}` : ''}`);
console.log(ok ? 'verify-console: PASS' : 'verify-console: FAIL', `→ ${path.relative(repo, evidence)}`);
process.exit(ok ? 0 : 1);
