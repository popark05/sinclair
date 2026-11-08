// Fleet 종단 증명(device-fleet 06): 실제 bin(control-plane 은 이미 떠 있음, 데몬은 여기서 띄움)으로 두 단계를 돌린다.
//   1단계 — 노드 A(Android 13, iOS 17)·노드 B(Android 14, Android 13 잠김)의 데몬 둘이 조건 타깃 3개(a13plus·a14·ios) Cycle 을 동시에 채운다:
//           도는 동안 Fleet 에 leased 셋 + 잠긴 기기 untrusted, 잠긴 기기는 어떤 Run 도 못 받고, Cycle verified, 셀마다 돈 기기, 실행 시간이 겹친다.
//   2단계 — 데몬 B 만 띄워 a13plus Run 을 B 기기에 주고 도중 SIGKILL → B 노드 offline → 데몬 A 를 띄우면 유예 뒤 대체 Run 을 A 의 맞는 기기가 받아 verified.
// 사용: node fleet-e2e.mjs <RUN_DIR> <lease-ttl-ms>   증거: <RUN_DIR>/evidence/fleet-e2e.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runDir, ttlText] = process.argv.slice(2);
if (!runDir || !ttlText) { console.error('사용: fleet-e2e.mjs <RUN_DIR> <lease-ttl-ms>'); process.exit(2); }
const TTL = Number(ttlText);
const REPO = process.cwd();
const { port, store } = JSON.parse(fs.readFileSync(path.join(runDir, 'server.json'), 'utf8'));
const URL0 = `http://127.0.0.1:${port}`;
const BIN = path.join(REPO, 'apps/runner-agent/bin/sinclair-agent.mjs');
const SUITE = 'apps/runner-agent/test/fixtures/slow';
const STAMP = `${Date.now()}-${process.pid}`;
const SLOW_MS = 2000;
const env = { ...process.env, SINCLAIR_E2E_SLOW_MS: String(SLOW_MS), SINCLAIR_E2E_SLOW_COUNT: '2' };
const mask = (line) => line.split(REPO).join('<repo>').split(os.homedir()).join('<home>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 이 증명의 판정 수. 판정을 더하면 문서의 "N/N" 도 함께 바꾼다 */
const EXPECTED_CHECKS = 11;

const dev = (id, platform, model, osVersion, locked = false) => ({ id, platform, model, osVersion, connection: 'device', helper: 'ready', locked });
const NODES = {
  a: [dev('A-AND13', 'android', 'FakePhone', '13'), dev('A-IOS17', 'ios', 'FakePad', '17')],
  b: [dev('B-AND14', 'android', 'FakePhone', '14'), dev('B-AND13-LOCKED', 'android', 'FakePhone', '13', true)],
};
for (const [n, devices] of Object.entries(NODES)) fs.writeFileSync(path.join(runDir, `fake-devices-${n}.json`), JSON.stringify(devices));

async function api(method, p, body) {
  const res = await fetch(`${URL0}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const view = async (id) => (await api('GET', `/cycles/${id}`)).body;
const fleet = async () => (await api('GET', '/fleet')).body;
const runView = async (id) => (await api('GET', `/runs/${encodeURIComponent(id)}`)).body;
async function until(what, cond, limitMs) {
  const t = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t > limitMs) throw new Error(`시간 초과(${limitMs}ms): ${what}`);
    await sleep(150);
  }
}
function daemon(node) {
  const name = `fleet-node-${node}`;
  const out = path.join(runDir, `fleet-e2e-${node}-${Date.now()}.out`);
  const fd = fs.openSync(out, 'w');
  const child = spawn(process.execPath, [BIN, 'daemon', '--control-plane', URL0, '--tests', SUITE, '--engine', 'fake', '--fake-devices', path.join(runDir, `fake-devices-${node}.json`), '--timeout', '200', '--agent', name, '--spool', path.join(runDir, `spool-${node}`), '--poll', '200'], { env, stdio: ['ignore', fd, fd] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { name, child, exited, log: () => fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(mask) };
}
async function stop(d) {
  if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGTERM');
  const r = await Promise.race([d.exited, sleep(20_000).then(() => { d.child.kill('SIGKILL'); return { code: null, signal: 'SIGKILL(timeout)' }; })]);
  return { ...r, log: d.log() };
}
const fleetSummary = (f) => f.nodes.map((n) => ({ agentId: n.agentId, online: n.online, devices: n.devices.map((d) => ({ id: d.id, platform: d.platform, osVersion: d.osVersion, state: d.state, reason: d.reason, runId: d.runId })) }));
const cycleSummary = (v) => ({
  cycleId: v.cycleId, state: v.state, verdict: v.verdict, targets: v.targets, targetSelectors: v.targetSelectors, retriesUsed: v.retriesUsed,
  runs: v.runs.map((r) => ({ runId: r.runId, targetId: r.targetId, state: r.state, deviceId: r.lease?.deviceId, agent: r.lease?.agentId, ...(r.replaces ? { replaces: r.replaces } : {}), ...(r.replacedBy ? { replacedBy: r.replacedBy } : {}) })),
  cells: Object.fromEntries(Object.entries(v.matrix).map(([t, row]) => [t, Object.fromEntries(Object.entries(row).map(([k, c]) => [k, `${c.verdict}@${c.deviceId ?? '-'}`]))])),
});

const evidence = { at: new Date().toISOString(), store, leaseTtlMs: TTL, nodes: NODES, suite: SUITE, slowMs: SLOW_MS, phases: {} };
const checks = [];
const check = (phase, label, ok) => { checks.push({ phase, label, ok: !!ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${phase}: ${label}`); };
const daemons = [];

try {
  // ---- 1단계: 두 노드가 조건 타깃 매트릭스를 동시에 채운다
  {
    const cycleId = `fleet-e2e-1-${STAMP}`;
    // a14 를 먼저 등록한다: 클레임은 등록 순서(FIFO)라 a14 는 맞는 기기가 B 의 Android 14 하나뿐이고, 나머지는 A 가 받는다(잠긴 B 기기는 후보가 아니다)
    const targets = [{ id: 'a14', platform: 'android', osVersion: { min: '14' } }, { id: 'a13plus', platform: 'android', osVersion: { min: '13' } }, { id: 'ios', platform: 'ios' }];
    const c = await api('POST', '/cycles', { cycleId, build: 'fleet-e2e', targets, suite: { tests: SUITE } });
    if (c.status !== 201) throw new Error(`Cycle 생성 실패 ${c.status}: ${JSON.stringify(c.body)}`);
    for (const t of targets) await api('POST', `/cycles/${cycleId}/runs`, { targetId: t.id, runId: `${cycleId}-${t.id}` });
    const a = daemon('a'); const b = daemon('b'); daemons.push(a, b);
    const during = await until('세 Run 이 모두 도는 중', async () => {
      const f = await fleet();
      const leased = f.nodes.flatMap((n) => n.devices).filter((d) => d.state === 'leased');
      return leased.length === 3 ? f : undefined;
    }, 40_000);
    const v = await until('1단계 Cycle finished', async () => { const x = await view(cycleId); return x.state === 'finished' ? x : undefined; }, 60_000);
    const spans = await Promise.all(v.runs.map((r) => runView(r.runId)));
    const aEnd = await stop(a); const bEnd = await stop(b);
    const s = cycleSummary(v);
    const locked = during.nodes.find((n) => n.agentId === 'fleet-node-b').devices.find((d) => d.id === 'B-AND13-LOCKED');
    const latestStart = Math.max(...spans.map((x) => Date.parse(x.startedAt)));
    const earliestEnd = Math.min(...spans.map((x) => Date.parse(x.finishedAt)));
    evidence.phases.concurrent = { cycle: s, fleetDuringRuns: fleetSummary(during), overlapMs: earliestEnd - latestStart, daemons: { a: { exit: aEnd.code, log: aEnd.log }, b: { exit: bEnd.code, log: bEnd.log } } };
    check('동시', 'Cycle finished/verified', s.state === 'finished' && s.verdict === 'verified');
    check('동시', '조건마다 맞는 기기: a14→B-AND14, a13plus→A-AND13, ios→A-IOS17', s.runs.find((r) => r.targetId === 'a14')?.deviceId === 'B-AND14' && s.runs.find((r) => r.targetId === 'a13plus')?.deviceId === 'A-AND13' && s.runs.find((r) => r.targetId === 'ios')?.deviceId === 'A-IOS17');
    check('동시', '셀마다 돈 기기가 보인다', Object.values(s.cells).every((row) => Object.values(row).every((c) => /^passed@/.test(c))) && Object.keys(s.cells).length > 0);
    check('동시', '도는 동안 Fleet 에 leased 셋', fleetSummary(during).flatMap((n) => n.devices).filter((d) => d.state === 'leased').length === 3);
    check('동시', '잠긴 기기는 untrusted(화면 잠김)이고 어떤 Run 도 받지 않음', locked?.state === 'untrusted' && locked?.reason === '화면 잠김' && !s.runs.some((r) => r.deviceId === 'B-AND13-LOCKED'));
    check('동시', '세 run 의 실행 시간이 겹친다', latestStart < earliestEnd);
    check('동시', '두 데몬 모두 정상 종료(exit 0)', aEnd.code === 0 && bEnd.code === 0);
  }

  // ---- 2단계: 노드 B 가 run 도중 죽고, 다른 노드의 맞는 기기에서 대체
  {
    const cycleId = `fleet-e2e-2-${STAMP}`;
    const c = await api('POST', '/cycles', { cycleId, build: 'fleet-e2e', targets: [{ id: 'a13plus', platform: 'android', osVersion: { min: '13' } }], retryLimit: 1, suite: { tests: SUITE } });
    if (c.status !== 201) throw new Error(`Cycle 생성 실패 ${c.status}`);
    const runId = `${cycleId}-r1`;
    await api('POST', `/cycles/${cycleId}/runs`, { targetId: 'a13plus', runId });
    const b = daemon('b'); daemons.push(b);
    await until('B 가 Run 을 돌리기 시작', async () => (await runView(runId))?.state === 'running', 30_000);
    const claimedBy = (await view(cycleId)).runs[0];
    b.child.kill('SIGKILL'); // 셸 bin 이 죽으면 IPC 가 끊겨 데몬이 끝나고, 데몬의 워커도 곧바로 끝난다(크래시 흉내)
    const bEnd = await b.exited;
    const offline = await until('B 노드 offline', async () => { const f = await fleet(); const n = f.nodes.find((x) => x.agentId === 'fleet-node-b'); return n && !n.online ? f : undefined; }, 4 * TTL + 10_000);
    const a = daemon('a'); daemons.push(a);
    const v = await until('2단계 Cycle finished', async () => { const x = await view(cycleId); return x.state === 'finished' ? x : undefined; }, 6 * TTL + 60_000);
    const aEnd = await stop(a);
    const s = cycleSummary(v);
    const [orig, rep] = s.runs;
    evidence.phases.nodeDeath = { cycle: s, claimedFirst: { deviceId: claimedBy.lease?.deviceId, agent: claimedBy.lease?.agentId }, fleetAfterKill: fleetSummary(offline), daemons: { b: { signal: bEnd.signal, log: b.log() }, a: { exit: aEnd.code, log: aEnd.log } } };
    check('노드 사망', '처음에는 B 의 맞는 기기(B-AND14)가 받음(잠긴 기기는 아님)', claimedBy.lease?.deviceId === 'B-AND14');
    check('노드 사망', 'B 를 죽이면 B 노드의 기기가 offline', fleetSummary(offline).find((n) => n.agentId === 'fleet-node-b').devices.every((d) => d.state === 'offline'));
    check('노드 사망', '원래 Run 은 infra-failed 로 대체되고 대체 Run 을 A 의 맞는 기기(A-AND13)가 받음', orig?.state === 'infra-failed' && orig?.replacedBy === rep?.runId && rep?.deviceId === 'A-AND13' && rep?.agent === 'fleet-node-a');
    check('노드 사망', 'Cycle verified, retriesUsed 1', s.verdict === 'verified' && s.retriesUsed?.a13plus === 1);
  }
} catch (err) {
  evidence.error = String(err instanceof Error ? err.message : err);
  console.error(`FLEET-E2E 오류: ${evidence.error}`);
} finally {
  for (const d of daemons) if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGKILL');
}

evidence.checks = checks;
const ok = !evidence.error && checks.length === EXPECTED_CHECKS && checks.every((c) => c.ok);
evidence.result = ok ? 'FLEET-E2E OK' : 'FLEET-E2E FAIL';
fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'evidence', 'fleet-e2e.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(`${evidence.result} checks=${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
