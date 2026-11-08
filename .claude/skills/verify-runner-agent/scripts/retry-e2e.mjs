// 재시도 정책 종단 증명: 실제 bin(control-plane 은 이미 떠 있음, 데몬은 여기서 띄움)으로 세 경로를 돌린다.
//   kill  — 데몬 A 를 run 도중 SIGKILL → 유예 뒤 버려진 Run(infra-failed) + 대체 Run → 데몬 B 가 재시도 포함으로 끝냄 → verified, passed-flaky
//   limit — retryLimit 0 으로 같은 시나리오 → 대체 없이 blocked
//   lease — A 의 heartbeat 만 프록시로 끊음 → 대체 Run 을 B 가 가져간 뒤 차단 해제 → A 는 409 replaced 를 받고 cancelled(코드 5) → Verdict 는 B 의 run
// 사용: node retry-e2e.mjs <RUN_DIR> <lease-ttl-ms>   (서버는 같은 TTL 로 기동돼 있어야 한다)  증거: <RUN_DIR>/evidence/retry-e2e.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runDir, ttlText] = process.argv.slice(2);
if (!runDir || !ttlText) { console.error('사용: retry-e2e.mjs <RUN_DIR> <lease-ttl-ms>'); process.exit(2); }
const TTL = Number(ttlText);
const REPO = process.cwd();
const { port, store } = JSON.parse(fs.readFileSync(path.join(runDir, 'server.json'), 'utf8'));
const URL0 = `http://127.0.0.1:${port}`;
const BIN = path.join(REPO, 'apps/runner-agent/bin/sinclair-agent.mjs');
const SUITE = 'apps/runner-agent/test/fixtures/retry-e2e';
const STAMP = `${Date.now()}-${process.pid}`;
// 데몬 A 를 죽이거나 끊을 시간이 있도록 run 을 길게 만든다: 버려짐 판정까지 lease 만료 ≤ TTL + 유예 TTL, 여유를 두고 그 두 배 이상
const SLOW_MS = Math.max(2000, Math.ceil(TTL / 2));
const SLOW_COUNT = Math.ceil((5 * TTL) / SLOW_MS) + 2;
const env = { ...process.env, SINCLAIR_E2E_SLOW_MS: String(SLOW_MS), SINCLAIR_E2E_SLOW_COUNT: String(SLOW_COUNT) };
const mask = (line) => line.split(REPO).join('<repo>').split(os.homedir()).join('<home>');
/** 경로별 판정 수(kill 4, limit 2, lease 4). 판정을 더하면 여기와 문서의 "10/10" 을 함께 바꾼다 */
const EXPECTED_CHECKS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(`${URL0}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const view = async (id) => (await api('GET', `/cycles/${id}`)).body;
async function until(what, cond, limitMs) {
  const t = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t > limitMs) throw new Error(`시간 초과(${limitMs}ms): ${what}`);
    await sleep(200);
  }
}

function daemon(name, target, controlPlane) {
  const out = path.join(runDir, `retry-${name}.out`);
  const fd = fs.openSync(out, 'w');
  const child = spawn(process.execPath, [BIN, 'daemon', '--control-plane', controlPlane, '--targets', target, '--tests', SUITE, '--engine', 'fake', '--timeout', '200', '--agent', name, '--spool', path.join(runDir, `spool-${name}`), '--poll', '200'], { env, stdio: ['ignore', fd, fd] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { name, child, exited, log: () => fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(mask) };
}
async function stop(d) {
  if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGTERM');
  const r = await Promise.race([d.exited, sleep(15_000).then(() => { d.child.kill('SIGKILL'); return { code: null, signal: 'SIGKILL(timeout)' }; })]);
  return { ...r, log: d.log() };
}
const summarize = (v) => ({
  cycleId: v.cycleId, state: v.state, verdict: v.verdict, retryLimit: v.retryLimit, retriesUsed: v.retriesUsed,
  runs: v.runs.map((r) => ({ runId: r.runId, state: r.state, agent: r.lease?.agentId, ...(r.replaces ? { replaces: r.replaces } : {}), ...(r.replacedBy ? { replacedBy: r.replacedBy, abandonedAt: r.abandonedAt } : {}) })),
  matrix: Object.fromEntries(Object.entries(v.matrix).map(([t, row]) => [t, Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c.verdict]))])),
});
async function newCycle(kind, retryLimit) {
  const cycleId = `retry-e2e-${kind}-${STAMP}`;
  const target = `e2e-${kind}`;
  const c = await api('POST', '/cycles', { cycleId, build: 'retry-e2e', targets: [target], retryLimit, suite: { tests: SUITE, retries: 1 } });
  if (c.status !== 201) throw new Error(`Cycle 생성 실패 ${c.status}: ${JSON.stringify(c.body)}`);
  const r = await api('POST', `/cycles/${cycleId}/runs`, { targetId: target, runId: `${kind}-r1-${STAMP}` });
  if (r.status !== 201) throw new Error(`Run 등록 실패 ${r.status}`);
  return { cycleId, target, runId: r.body.runId };
}
const running = (cycleId, runId) => until(`${runId} 이 이벤트를 보내기 시작`, async () => (await view(cycleId)).runs.find((r) => r.runId === runId)?.state === 'running', 30_000);
const finished = (cycleId, limit = 60_000 + SLOW_MS * SLOW_COUNT * 2) => until(`${cycleId} finished`, async () => { const v = await view(cycleId); return v.state === 'finished' ? v : undefined; }, limit);

const evidence = { at: new Date().toISOString(), store, leaseTtlMs: TTL, graceMs: TTL, suite: SUITE, slow: { ms: SLOW_MS, count: SLOW_COUNT }, paths: {} };
const checks = [];
const check = (pathName, label, ok) => { checks.push({ path: pathName, label, ok: !!ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${pathName}: ${label}`); };
const daemons = [];

try {
  // ---- kill: 강제 종료 → 대체 Run → 재시도 포함 완료
  {
    const k = await newCycle('kill', 1);
    const a = daemon('kill-a', k.target, URL0); daemons.push(a);
    await running(k.cycleId, k.runId);
    const killedAt = Date.now();
    a.child.kill('SIGKILL'); // 셸 bin 이 죽으면 IPC 가 끊겨 실제 에이전트도 곧바로 끝난다(heartbeat 가 멈춘다)
    const aEnd = await a.exited;
    const b = daemon('kill-b', k.target, URL0); daemons.push(b);
    const v = await finished(k.cycleId);
    const bEnd = await stop(b);
    const s = summarize(v);
    const [orig, rep] = s.runs;
    evidence.paths.kill = { cycle: s, killedAfterMs: Date.now() - killedAt, daemonA: { signal: aEnd.signal, log: a.log() }, daemonB: { exit: bEnd.code, log: bEnd.log } };
    check('kill', '원래 Run 은 infra-failed 이고 대체됨', orig?.state === 'infra-failed' && orig?.replacedBy === rep?.runId);
    check('kill', '대체 Run 을 데몬 B 가 끝냄', rep?.replaces === k.runId && rep?.state === 'finished' && rep?.agent === 'kill-b');
    check('kill', 'Cycle verified, retriesUsed 1', s.verdict === 'verified' && s.retriesUsed[k.target] === 1);
    check('kill', '재시도 테스트가 passed-flaky', s.matrix['재시도 > 첫 시도만 실패한다']?.[k.target] === 'passed-flaky');
  }

  // ---- limit: retryLimit 0 → 대체 없이 blocked
  {
    const l = await newCycle('limit', 0);
    const a = daemon('limit-a', l.target, URL0); daemons.push(a);
    await running(l.cycleId, l.runId);
    a.child.kill('SIGKILL');
    const aEnd = await a.exited;
    const v = await finished(l.cycleId, 4 * TTL + 20_000); // 조회가 정리 시점이다(대체 Run 이 없으니 데몬 B 도 필요 없다)
    const s = summarize(v);
    evidence.paths.limit = { cycle: s, daemonA: { signal: aEnd.signal, log: a.log() } };
    check('limit', '대체 Run 없이 infra-failed 하나', s.runs.length === 1 && s.runs[0].state === 'infra-failed' && !s.runs[0].replacedBy);
    check('limit', 'Cycle finished/blocked, retriesUsed 0', s.verdict === 'blocked' && s.retriesUsed[l.target] === 0);
  }

  // ---- lease: heartbeat 만 끊음 → 대체 → 차단 해제 → A cancelled
  {
    const blockFile = path.join(runDir, 'hb-block');
    const portFile = path.join(runDir, 'hb-proxy.port');
    fs.rmSync(blockFile, { force: true }); fs.rmSync(portFile, { force: true });
    const proxyOut = fs.openSync(path.join(runDir, 'hb-proxy.out'), 'w');
    const proxy = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'hb-proxy.mjs'), URL0, blockFile, portFile], { stdio: ['ignore', proxyOut, proxyOut] });
    try {
      const proxyPort = await until('프록시 포트', () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : ''), 5_000);
      const c = await newCycle('lease', 1);
      const a = daemon('lease-a', c.target, `http://127.0.0.1:${proxyPort}`); daemons.push(a);
      await running(c.cycleId, c.runId);
      fs.writeFileSync(blockFile, ''); // 네트워크 차단 흉내: 이벤트는 가고 heartbeat 만 안 간다
      const blockedAt = Date.now();
      const b = daemon('lease-b', c.target, URL0); daemons.push(b);
      const rep = await until('대체 Run 을 B 가 클레임', async () => { const v = await view(c.cycleId); const r = v.runs.find((x) => x.replaces === c.runId); return r?.lease?.agentId === 'lease-b' ? r : undefined; }, 4 * TTL + 20_000);
      fs.rmSync(blockFile); // 차단 해제: A 의 다음 heartbeat 는 409 replaced
      const unblockedAfterMs = Date.now() - blockedAt;
      await until('A 가 lease 를 잃어 중단', () => a.log().some((l) => l.includes('lease 를 잃어 중단')), 6 * TTL + SLOW_MS * 2);
      const v = await finished(c.cycleId);
      const aEnd = await stop(a); const bEnd = await stop(b);
      const s = summarize(v);
      const summaryLine = aEnd.log.find((l) => l.startsWith('데몬 요약')) ?? '';
      evidence.paths.lease = { cycle: s, unblockedAfterMs, daemonA: { exit: aEnd.code, log: aEnd.log }, daemonB: { exit: bEnd.code, log: bEnd.log }, proxy: fs.readFileSync(path.join(runDir, 'hb-proxy.out'), 'utf8').split('\n').filter(Boolean) };
      check('lease', 'A 의 heartbeat 가 replaced(409) 를 받고 run 이 중단(코드 5)', aEnd.log.some((l) => l.includes(`heartbeat ${c.runId}: replaced`)) && summaryLine.includes(`${c.target}:5`));
      check('lease', 'A 프로세스는 중단을 실패로 세지 않음(exit 0)', aEnd.code === 0);
      check('lease', '원래 Run 은 대체됐고 Verdict 는 B 의 run', s.runs[0]?.replacedBy === rep.runId && s.runs[1]?.agent === 'lease-b' && s.runs[1]?.state === 'finished');
      check('lease', 'Cycle verified, passed-flaky', s.verdict === 'verified' && s.matrix['재시도 > 첫 시도만 실패한다']?.[c.target] === 'passed-flaky');
    } finally {
      const gone = new Promise((r) => proxy.on('exit', r));
      proxy.kill('SIGTERM');
      await Promise.race([gone, sleep(3_000).then(() => proxy.kill('SIGKILL'))]);
    }
  }
} catch (err) {
  evidence.error = String(err instanceof Error ? err.message : err);
  console.error(`RETRY-E2E 오류: ${evidence.error}`);
} finally {
  for (const d of daemons) if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGKILL');
}

evidence.checks = checks;
const ok = !evidence.error && checks.length === EXPECTED_CHECKS && checks.every((c) => c.ok);
evidence.result = ok ? 'RETRY-E2E OK' : 'RETRY-E2E FAIL';
fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'evidence', 'retry-e2e.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(`${evidence.result} checks=${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
