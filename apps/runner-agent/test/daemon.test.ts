// @vitest-environment node
// runDaemon: 인프로세스 control-plane + FakeEngine. 타깃 2개 Cycle 을 데몬 2개가 채우고, 실패 뒤에도 계속 돌며, lease 가 만료되면 다른 에이전트가 가져간다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, serveControlPlane, createMemoryEventStore, type RunningControlPlane, type CycleView, type FleetView } from '@sinclair/control-plane';
import { EngineError } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { runDaemon, parseDaemonArgs, reportNode, AgentConfigError, EXIT, type DaemonDeps } from '../src/index.ts';

const MEMORY = { host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' } as const;
const fixtures = path.resolve(import.meta.dirname, 'fixtures');
let cp: RunningControlPlane | undefined;
let url: string;
let spool: string;
const logs: string[] = [];
beforeEach(async () => { cp = await startControlPlane(MEMORY); url = `http://127.0.0.1:${cp.server.port}`; spool = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-daemon-')); logs.length = 0; });
afterEach(async () => { await cp?.close(); cp = undefined; fs.rmSync(spool, { recursive: true, force: true }); });

const fakeEngine = async (a?: { device?: string }) => { const e = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) }); return { engine: e, dispose: () => e.dispose(), deviceId: a?.device ?? 'fake' }; };
// sleep 은 20ms 로 눌러 폴링 간격(pollMs)과 무관하게 테스트가 빨리 돈다
const deps = (extra: Partial<DaemonDeps> = {}): DaemonDeps => ({ log: (l) => logs.push(l), createEngine: fakeEngine, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), ...extra });
/** 조건이 참이 될 때까지 폴링(상한 limitMs). 전체 스위트 병렬 실행에서 고정 대기는 흔들린다 */
const until = async (cond: () => Promise<boolean> | boolean, limitMs = 6_000) => { const t = Date.now(); while (!(await cond()) && Date.now() - t < limitMs) await new Promise((r) => setTimeout(r, 20)); };
const post = (p: string, body: unknown) => fetch(`${url}${p}`, { method: 'POST', body: JSON.stringify(body) });
const view = async (id: string) => (await (await fetch(`${url}/cycles/${id}`)).json()) as CycleView;

describe('runDaemon', () => {
  it('타깃 2개 Cycle 을 데몬 2개(각 타깃)가 클레임해 채우면 Cycle 이 finished/verified 다. suite.tests 를 따른다', async () => {
    await post('/cycles', { cycleId: 'c1', build: 'b', targets: ['android', 'ios'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/c1/runs', { targetId: 'android' });
    await post('/cycles/c1/runs', { targetId: 'ios' });
    const [a, b] = await Promise.all([
      runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-a', pollMs: 10 }, deps({ maxRuns: 1 })),
      runDaemon({ controlPlane: url, targets: ['ios'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-b', pollMs: 10 }, deps({ maxRuns: 1 })),
    ]);
    expect(a.runs).toEqual([{ runId: expect.any(String), targetId: 'android', exitCode: EXIT.ok }]);
    expect(b.runs).toEqual([{ runId: expect.any(String), targetId: 'ios', exitCode: EXIT.ok }]);
    const v = await view('c1');
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(v.runs.map((r) => r.lease?.agentId).sort()).toEqual(['node-a', 'node-b']);
    expect(logs.join('\n')).toMatch(/tests .*only-login/); // Cycle 의 suite 를 썼다(기본 fixtures 가 아니라)
    expect(fs.readdirSync(spool)).toEqual([]); // 스풀은 다 보내고 치워졌다
  });

  it('Cycle 의 suite.retries 가 노드의 --retries 보다 우선한다: 첫 시도만 실패하는 테스트가 재시도로 통과해 Cycle 매트릭스에 passed-flaky', async () => {
    await post('/cycles', { cycleId: 'cf', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'flaky'), retries: 1 } });
    await post('/cycles/cf/runs', { targetId: 'android' });
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', retries: 0, timeoutMs: 100, spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-f', pollMs: 10 }, deps({ maxRuns: 1 }));
    expect(r.runs[0]!.exitCode).toBe(EXIT.ok);
    expect(logs.join('\n')).toMatch(/retries 1/);
    const v = await view('cf');
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(v.matrix['첫 시도에만 실패한다']!.android).toMatchObject({ verdict: 'passed-flaky' });
  });

  it('대체 Run 은 앞 Run 에서 결과가 확정된 케이스를 건너뛴다(클레임의 skipTests): 남은 케이스만 돌고 Cycle 은 앞 Run 결과를 이어받아 verified', async () => {
    await post('/cycles', { cycleId: 'cr', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'three') } });
    await post('/cycles/cr/runs', { targetId: 'android', runId: 'r0' });
    // 다른 노드가 클레임해 첫째를 끝낸 뒤 취소됨(종료 신호): 대체 Run 이 생긴다
    const claimed = await (await post('/runs/claim', { targetId: 'android', agentId: 'gone', devices: ['fake'] })).json() as { run: { runId: string } };
    const runId = claimed.run.runId;
    const at = new Date().toISOString();
    const ev = (eventId: string, e: object) => ({ schema: 1, eventId, runId, at, ...e });
    await post('/ingest', [
      ev('s', { type: 'run.started', cycleId: 'cr', targetId: 'android', deviceId: 'fake', agentId: 'gone' }),
      ev('a1', { type: 'attempt.started', attemptId: 'x1', testId: '첫째', attemptNo: 1 }),
      ev('f1', { type: 'attempt.finished', attemptId: 'x1', result: 'passed', artifacts: [] }),
      ev('a2', { type: 'attempt.started', attemptId: 'x2', testId: '둘째', attemptNo: 1 }),
      ev('f2', { type: 'attempt.finished', attemptId: 'x2', result: 'skipped', errorCode: 'cancelled', artifacts: [] }),
      ev('e', { type: 'run.finished', state: 'cancelled' }),
    ]);
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-r', pollMs: 10 }, deps({ maxRuns: 1 }));
    expect(r.runs).toEqual([{ runId: `retry:${runId}`, targetId: 'android', exitCode: EXIT.ok }]);
    expect(logs.join('\n')).toMatch(/확정 케이스 1개 건너뜀/);
    const v = await view('cr');
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(Object.fromEntries(Object.entries(v.matrix).map(([t, row]) => [t, row.android?.verdict]))).toEqual({ 첫째: 'passed', 둘째: 'passed', 셋째: 'passed' });
    const rep = (await (await fetch(`${url}/runs/${encodeURIComponent(`retry:${runId}`)}`)).json()) as { attempts: Array<{ testId: string }> };
    expect(rep.attempts.map((a) => a.testId)).toEqual(['둘째', '셋째']); // 첫째는 다시 돌지 않았다
  });

  it('실패한 run 뒤에도 다음 Run 을 계속 가져가고, 대기 중인 Run 이 없으면 폴링하다가 신호에 멈춘다', async () => {
    await post('/cycles', { cycleId: 'c2', build: 'b', targets: ['android'], suite: { tests: fixtures } }); // 통과 1 + 실패 1
    await post('/cycles/c2/runs', { targetId: 'android', runId: 'r-first' });
    await post('/cycles/c2/runs', { targetId: 'android', runId: 'r-second' });
    const aborter = new AbortController();
    const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'n', pollMs: 10, timeoutMs: 100 }, deps({ signal: aborter.signal }));
    await until(async () => (await view('c2')).runs.every((r) => r.state === 'finished'));
    await new Promise((r) => setTimeout(r, 60)); // 폴링(20ms 로 눌림) 한두 번 돌 시간
    aborter.abort();
    const summary = await p;
    expect(summary.stoppedBy).toBe('signal');
    expect(summary.runs.map((r) => [r.runId, r.exitCode])).toEqual([['r-first', EXIT.testsFailed], ['r-second', EXIT.testsFailed]]);
    expect(logs.at(-1)).toBe('데몬 종료');
  });

  it.each([[409, 'not-owner'], [409, 'replaced'], [404, 'no-run']] as const)('heartbeat 가 %i(%s) 면 러너를 취소한다: 현재 테스트만 마치고 run 은 cancelled, 로그 "lease 를 잃어 중단", 다음 클레임은 계속', async (status, outcome) => {
    await cp!.close();
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000 }); // heartbeat 간격 1초(하한)
    url = `http://127.0.0.1:${srv.port}`;
    try {
      await post('/cycles', { cycleId: 'cl', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'three') } });
      await post('/cycles/cl/runs', { targetId: 'android', runId: 'r-lost' });
      await post('/cycles/cl/runs', { targetId: 'android', runId: 'r-next' });
      // 첫 run 의 heartbeat 는 409(다른 에이전트가 가져감)로 답한다; 두 번째 테스트는 heartbeat 가 한 번 돌 때까지 붙잡는다
      let gate!: () => void; const held = new Promise<void>((r) => { gate = r; });
      const lostFetch: typeof fetch = async (input, init) => (String(input).endsWith('/runs/r-lost/heartbeat') ? new Response(JSON.stringify({ error: outcome, code: outcome }), { status }) : fetch(input, init));
      let opens = 0;
      const engineHook = async () => { const h = await fakeEngine(); const open = h.engine.session!.open; h.engine.session!.open = async (t) => { await open(t); if (++opens === 2) await held; }; return h; };
      const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'n', pollMs: 10 }, deps({ maxRuns: 2, fetch: lostFetch, createEngine: engineHook }));
      await until(() => logs.some((l) => l.includes(`heartbeat r-lost: ${outcome}`)), 4_000);
      gate();
      const summary = await p;
      expect(summary.runs.map((r) => [r.runId, r.exitCode, r.leaseLost, r.cancelled])).toEqual([['r-lost', EXIT.cancelled, true, 'lease 를 잃음'], ['r-next', EXIT.ok, undefined, undefined]]);
      expect(logs.join('\n')).toMatch(/r-lost: lease 를 잃어 중단/);
      const v = await view('cl');
      // 취소로 끝난 run 은 control-plane 이 같은 타깃에 다시 올린다(followups 05). replaced 는 이미 대체 Run 이 있어 그 Run 이 그대로 대체
      expect(v.runs.map((r) => [r.runId, r.state, r.replacedBy])).toEqual([['r-lost', 'cancelled', 'retry:r-lost'], ['r-next', 'finished', undefined], ['retry:r-lost', 'queued', undefined]]);
    } finally { await srv.close(); cp = undefined; }
  }, 15_000);

  it('데몬 종료 신호는 진행 중 run 의 현재 테스트만 마치고 나머지를 skipped 로 보고해 run 이 cancelled 로 끝난다(exit 5)', async () => {
    await post('/cycles', { cycleId: 'cc', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'three') } });
    await post('/cycles/cc/runs', { targetId: 'android', runId: 'r-cancel' });
    const aborter = new AbortController();
    // 두 번째 테스트가 시작(open)된 직후 데몬에 종료 신호
    let opens = 0;
    const engineHook = async () => { const h = await fakeEngine(); const open = h.engine.session!.open; h.engine.session!.open = async (t) => { await open(t); if (++opens === 2) aborter.abort(); }; return h; };
    const summary = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'n', pollMs: 10 }, deps({ signal: aborter.signal, createEngine: engineHook }));
    expect(summary.stoppedBy).toBe('signal');
    expect(summary.runs).toEqual([{ runId: 'r-cancel', targetId: 'android', exitCode: EXIT.cancelled, cancelled: '종료 신호' }]);
    const v = await view('cc');
    // 취소된 run 은 대체 Run 으로 다시 올라가 Cycle 은 아직 끝나지 않았다(followups 05). 취소된 run 의 Attempt 는 이벤트로 남는다
    expect(v).toMatchObject({ state: 'running', verdict: 'incomplete', retriesUsed: { android: 0 }, runs: [{ runId: 'r-cancel', state: 'cancelled', replacedBy: 'retry:r-cancel' }, { runId: 'retry:r-cancel', state: 'queued', replaceReason: 'cancelled' }] });
    const rv = await (await fetch(`${url}/runs/r-cancel`)).json() as { attempts: Array<{ testId: string; result: string; errorCode?: string }> };
    // 같은 ms 의 이벤트는 투영 순서가 바뀔 수 있어 이름으로 본다. 셋째는 취소로 돌지 않았다
    expect(['첫째', '둘째', '셋째'].map((t) => rv.attempts.find((a) => a.testId === t)?.result)).toEqual(['passed', 'passed', 'skipped']);
    expect(logs.join('\n')).toMatch(/중단\(cancelled\): 종료 신호/);
  });

  it('lease 가 만료된 Run 은 다른 데몬이 가져가고, lease 를 잃은 데몬은 경고를 남긴다', async () => {
    await cp!.close();
    let now = Date.parse('2026-11-08T00:00:00.000Z');
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000, now: () => now });
    url = `http://127.0.0.1:${srv.port}`;
    try {
      await post('/cycles', { cycleId: 'c3', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
      await post('/cycles/c3/runs', { targetId: 'android', runId: 'r-lease' });
      // "죽은" 에이전트: 클레임 뒤 엔진 준비에서 멈추고 heartbeat 도 네트워크가 끊겨 닿지 않는다(그래야 lease 가 만료된다)
      const dead = new AbortController();
      let release!: () => void;
      const deadFetch: typeof fetch = (input, init) => (String(input).endsWith('/heartbeat') ? Promise.reject(new Error('네트워크 끊김')) : fetch(input, init));
      const stuck = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'dead-agent', pollMs: 10 }, deps({
        signal: dead.signal, fetch: deadFetch,
        createEngine: () => new Promise((_, reject) => { release = () => reject(new Error('에이전트 종료')); }), // abort 때 풀어 준다
      }));
      await until(async () => !!(await view('c3')).runs[0]!.lease);
      expect((await view('c3')).runs[0]!.lease?.agentId).toBe('dead-agent');
      // 만료 전에는 못 가져간다: 짧은 TTL 안에서 몇 번 폴링하고 신호로 멈춘다
      const early = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'live-agent', pollMs: 10 }, deps({ maxRuns: 1, signal: AbortSignal.timeout(150) }));
      expect(early.runs).toEqual([]);
      expect(logs.filter((l) => /클레임 \(/.test(l))).toHaveLength(1); // dead-agent 의 클레임뿐
      now += 3_000; // 만료
      const late = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'live-agent', pollMs: 10 }, deps({ maxRuns: 1 }));
      expect(late.runs).toEqual([{ runId: 'r-lease', targetId: 'android', exitCode: EXIT.ok }]);
      expect((await view('c3'))).toMatchObject({ state: 'finished', verdict: 'verified', runs: [{ lease: { agentId: 'live-agent' } }] });
      // 죽은 에이전트를 깨우면 엔진 실패 → infra-failed 보고 시도(blocked) 로 끝나고 루프를 나온다
      dead.abort(); release();
      const stuckSummary = await stuck;
      expect(stuckSummary.runs).toEqual([{ runId: 'r-lease', targetId: 'android', exitCode: EXIT.blocked }]); // 종료 신호가 왔지만 엔진이 없어 blocked 로 끝남(중단된 run 이 아님)
    } finally {
      await srv.close();
      cp = undefined;
    }
  });

});

describe('parseDaemonArgs', () => {
  it('필수값·타깃 목록·기본값, 잘못된 값', () => {
    expect(parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'android, ios', '--tests', 'd', '--poll', '100'], { HOME: '/h' }, 'linux')).toEqual({ controlPlane: 'http://x', targets: ['android', 'ios'], tests: 'd', engine: 'mobile', cache: 'read-write', spool: '/h/.local/share/sinclair/spool', helperCache: '/h/.local/share/sinclair/cache/helper', pollMs: 100 });
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'a', '--tests', 'd', '--poll', '50'], {})).toThrow(/100 이상/);
    // --targets 는 선택(device-fleet 03): 조건 타깃만 쓰는 Cycle 이면 선언할 이름이 없다
    expect(parseDaemonArgs(['--control-plane', 'http://x', '--tests', 'd'], { HOME: '/h' }, 'linux')).toMatchObject({ targets: [] });
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'a', '--tests', 'd', '--poll', 'x'], {})).toThrow(AgentConfigError);
    expect(parseDaemonArgs(['--help'], {})).toEqual({ help: true });
  });
});

describe('runDaemon · Fleet 보고', () => {
  const fleet = async () => (await (await fetch(`${url}/fleet`)).json()) as FleetView;
  const dev = (id: string, locked = false) => ({ id, platform: 'android' as const, model: 'SM-N981N', osVersion: '13', connection: 'device' as const, helper: 'ready' as const, locked });

  it('데몬은 시작할 때와 TTL/3 마다 기기를 보고한다: GET /fleet 에 노드와 기기 상태가 보이고, 바뀐 상태가 다음 보고에 반영된다', async () => {
    await cp!.close();
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000 }); // 보고 간격 1초(하한)
    url = `http://127.0.0.1:${srv.port}`;
    try {
      let locked = false;
      const aborter = new AbortController();
      const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-f', pollMs: 50 }, deps({ signal: aborter.signal, inventory: async () => [dev('SER-A'), dev('SER-B', locked)] }));
      await until(async () => (await fleet()).nodes.length === 1);
      expect((await fleet()).nodes[0]).toMatchObject({ agentId: 'node-f', online: true, devices: [{ id: 'SER-A', state: 'idle' }, { id: 'SER-B', state: 'idle' }] });
      locked = true;
      await until(async () => (await fleet()).nodes[0]!.devices[1]!.state === 'untrusted', 4_000);
      expect((await fleet()).nodes[0]!.devices[1]).toMatchObject({ state: 'untrusted', reason: '화면 잠김' });
      aborter.abort();
      await p;
      expect(logs.some((l) => /fleet 보고: 기기 2대/.test(l))).toBe(true);
      expect(logs.join('\n')).not.toMatch(/SER-A|SER-B/); // 로그에 시리얼을 쓰지 않는다
    } finally { await srv.close(); cp = undefined; }
  }, 15_000);

  it('인벤토리 읽기가 멈춰도(기기 목록이 답하지 않음) 기한 뒤 실패로 남기고 다음 보고를 이어 간다 — 실기에서 한 번 멈춘 목록에 보고 사슬이 영영 끊겼다', async () => {
    await cp!.close();
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000 }); // 보고 간격 1초
    url = `http://127.0.0.1:${srv.port}`;
    try {
      // 보고가 잘 되다가(TTL 을 알고) 어느 읽기에서 영영 답하지 않는다 — 실기 상황
      let calls = 0;
      let stuckAt = 0;
      const inventory = async () => { if (++calls === 3) { stuckAt = Date.now(); return new Promise<never>(() => {}); } return [dev('SER-A')]; };
      const aborter = new AbortController();
      const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-h', pollMs: 50 }, deps({ signal: aborter.signal, inventory, inventoryTimeoutMs: 200 }));
      await until(() => stuckAt > 0, 6_000);
      // 멈춘 읽기 뒤에도 보고가 이어진다(보고 시각이 그 뒤로 갱신)
      await until(async () => Date.parse((await fleet()).nodes[0]?.reportedAt ?? '0') > stuckAt + 200, 6_000);
      expect(Date.parse((await fleet()).nodes[0]!.reportedAt)).toBeGreaterThan(stuckAt + 200);
      expect(logs.some((l) => /인벤토리가 200ms 안에 끝나지 않음/.test(l))).toBe(true);
      aborter.abort();
      await p;
    } finally { await srv.close(); cp = undefined; }
  }, 15_000);

  it('데몬이 멈출 때 진행 중이던 보고가 끝나기를 기다리고, 멈춘 뒤에는 보고를 보내지 않는다(닫히는 백엔드의 덜 채운 보고가 덮어쓰지 않게)', async () => {
    await cp!.close();
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000 }); // 보고 간격 1초
    url = `http://127.0.0.1:${srv.port}`;
    try {
      let calls = 0;
      let stopped = false;
      const puts: number[] = [];
      const counting: typeof fetch = (input, init) => { if (String(input).includes('/fleet/nodes/')) puts.push(Date.now()); return fetch(input, init); };
      // 두 번째 인벤토리는 느리고, 데몬이 멈춘 뒤에 끝나면 잠금 정보를 잃은 보고를 돌려준다(닫히는 백엔드 흉내)
      const inventory = async () => {
        if (++calls === 1) return [dev('SER-A')];
        await new Promise((r) => setTimeout(r, 600));
        const { locked: _l, ...degraded } = dev('SER-A');
        return [stopped ? degraded : dev('SER-A')];
      };
      const aborter = new AbortController();
      const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-s', pollMs: 50 }, deps({ signal: aborter.signal, inventory, fetch: counting }));
      await until(() => calls >= 2, 4_000); // 두 번째 보고가 인벤토리 중
      aborter.abort(); stopped = true;
      await p;
      const returnedAt = Date.now();
      await new Promise((r) => setTimeout(r, 900));
      expect(puts.filter((t) => t > returnedAt)).toEqual([]); // 멈춘 뒤 보고 없음
      expect((await fleet()).nodes[0]!.devices[0]).toMatchObject({ locked: false });
    } finally { await srv.close(); cp = undefined; }
  }, 15_000);

  it('reportNode 는 ttlMs 가 숫자가 아닌 응답을 거부한다(간격이 NaN 이 되어 서버를 두드리지 않게)', async () => {
    const bad: typeof fetch = async () => new Response(JSON.stringify({ ttlMs: 'soon' }), { status: 200 });
    await expect(reportNode('http://x', 'n', [], bad)).rejects.toThrow(/ttlMs/);
    const zero: typeof fetch = async () => new Response(JSON.stringify({ ttlMs: 0 }), { status: 200 });
    await expect(reportNode('http://x', 'n', [], zero)).rejects.toThrow(/ttlMs/);
  });

  it('fake 엔진 데몬은 가짜 기기 하나를 보고하고, 보고가 실패해도 클레임은 계속된다', async () => {
    await post('/cycles', { cycleId: 'cf2', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cf2/runs', { targetId: 'android' });
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-g', pollMs: 10 }, deps({ maxRuns: 1 }));
    expect(r.runs[0]!.exitCode).toBe(EXIT.ok);
    expect((await fleet()).nodes.find((n) => n.agentId === 'node-g')!.devices).toMatchObject([{ id: 'fake-node-g', model: 'FakeEngine', state: 'idle' }]);
    // 보고 경로만 깨진 서버: PUT 이 실패해도 run 은 돈다
    logs.length = 0;
    await post('/cycles', { cycleId: 'cf3', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cf3/runs', { targetId: 'android' });
    const broken: typeof fetch = (input, init) => (String(input).includes('/fleet/') ? Promise.reject(new Error('보고 경로 차단')) : fetch(input, init));
    const r2 = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-h', pollMs: 10 }, deps({ maxRuns: 1, fetch: broken }));
    expect(r2.runs[0]!.exitCode).toBe(EXIT.ok);
    expect(logs.some((l) => /fleet 보고 실패/.test(l))).toBe(true);
  });
});

describe('runDaemon · 기기 lease', () => {
  it('클레임에 인벤토리 기기를 후보로 보내고 lease 받은 기기로 엔진을 만든다: run 중에는 Fleet 에 leased, 끝나면 idle; run.started 기기가 lease 와 같아 경고가 없다', async () => {
    await post('/cycles', { cycleId: 'cd', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cd/runs', { targetId: 'android', runId: 'r-dev' });
    const dev = (id: string) => ({ id, platform: 'android' as const, model: 'SM-N981N', osVersion: '13', connection: 'device' as const, helper: 'ready' as const, locked: false });
    let seenDevice: string | undefined;
    let midRun: unknown;
    const engineSpy = async (a: { device?: string }) => {
      seenDevice = a.device;
      midRun = (await (await fetch(`${url}/fleet`)).json() as FleetView).nodes.find((n) => n.agentId === 'node-d')?.devices.map((d) => [d.id, d.state, d.runId]);
      return fakeEngine(a);
    };
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-d', pollMs: 10 }, deps({ maxRuns: 1, inventory: async () => [dev('SER-1'), dev('SER-2')], createEngine: engineSpy }));
    expect(r.runs[0]!.exitCode).toBe(EXIT.ok);
    expect(seenDevice).toBe('SER-1');
    expect(midRun).toEqual([['SER-1', 'leased', 'r-dev'], ['SER-2', 'idle', undefined]]);
    const after = (await (await fetch(`${url}/fleet`)).json() as FleetView).nodes.find((n) => n.agentId === 'node-d')!;
    expect(after.devices.map((d) => d.state)).toEqual(['idle', 'idle']);
    const v = await view('cd') as CycleView & { warnings?: string[] };
    expect(v.runs[0]!.lease?.deviceId).toBe('SER-1');
    expect(v.warnings).toBeUndefined();
    expect(logs.join('\n')).toMatch(/기기 …ER-1/);
    expect(logs.join('\n')).not.toMatch(/SER-1/);
  });

  it('--device 로 고정한 데몬은 그 기기만 후보로 낸다; lease 받은 기기를 못 찾으면 blocked 로 끝나고 기기가 풀려 다음 Run 이 받는다', async () => {
    await post('/cycles', { cycleId: 'cp', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cp/runs', { targetId: 'android', runId: 'r-p1' });
    await post('/cycles/cp/runs', { targetId: 'android', runId: 'r-p2' });
    const dev = (id: string) => ({ id, platform: 'android' as const, model: 'SM-N981N', osVersion: '13', connection: 'device' as const, helper: 'ready' as const, locked: false });
    const seen: Array<string | undefined> = [];
    let first = true;
    const engine = async (a: { device?: string }) => {
      seen.push(a.device);
      if (first) { first = false; throw new Error(`기기 ${a.device} 가 목록에 없음`); } // 클레임과 엔진 준비 사이에 뽑힘
      return fakeEngine(a);
    };
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', device: 'SER-2', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-p', pollMs: 10 }, deps({ maxRuns: 2, inventory: async () => [dev('SER-1'), dev('SER-2')], createEngine: engine }));
    expect(seen).toEqual(['SER-2', 'SER-2']); // SER-1 은 비어 있어도 쓰지 않는다
    expect(r.runs.map((x) => [x.runId, x.exitCode])).toEqual([['r-p1', EXIT.blocked], ['r-p2', EXIT.ok]]);
    const v = await view('cp');
    expect(v.runs.map((x) => [x.runId, x.state, x.lease?.deviceId])).toEqual([['r-p1', 'infra-failed', 'SER-2'], ['r-p2', 'finished', 'SER-2']]);
  });

  it('기기가 없는 노드는 Run 을 클레임하지 않는다(받아도 돌릴 기기가 없다)', async () => {
    await post('/cycles', { cycleId: 'ce', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/ce/runs', { targetId: 'android' });
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-e', pollMs: 10 }, deps({ signal: AbortSignal.timeout(300), inventory: async () => [] }));
    expect(r.runs).toEqual([]);
    expect(logs.filter((l) => /후보 기기 없음/.test(l))).toHaveLength(1); // 조용히 기다리지 않되, 폴링마다 찍지는 않는다
    expect((await view('ce')).runs[0]!.lease).toBeUndefined();
  });
});

describe('runDaemon · 기기 상태로 클레임 거르기', () => {
  const dev = (id: string, over: Record<string, unknown> = {}) => ({ id, platform: 'android' as const, model: 'SM-N981N', osVersion: '13', connection: 'device' as const, helper: 'ready' as const, locked: false, ...over });

  it('잠긴 기기는 후보로 내지 않아 Run 은 쓸 수 있는 기기로 가고, 풀리면 다음 Run 을 받는다; 제외 사유는 바뀔 때만 한 줄', async () => {
    await post('/cycles', { cycleId: 'ch', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/ch/runs', { targetId: 'android', runId: 'r-h1' });
    await post('/cycles/ch/runs', { targetId: 'android', runId: 'r-h2' });
    let phase = 1;
    const inventory = async () => (phase === 1 ? [dev('LOCK-1', { locked: true }), dev('GOOD-1')] : [dev('LOCK-1'), dev('GOOD-1', { helper: 'disabled' })]);
    const used: Array<string | undefined> = [];
    const engine = async (a: { device?: string }) => { used.push(a.device); phase = 2; return fakeEngine(a); }; // 첫 run 이 도는 사이 상태가 바뀐다
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-h', pollMs: 10 }, deps({ maxRuns: 2, inventory, createEngine: engine }));
    expect(r.runs.map((x) => x.exitCode)).toEqual([EXIT.ok, EXIT.ok]);
    expect(used).toEqual(['GOOD-1', 'LOCK-1']);
    const excluded = logs.filter((l) => /후보에서 뺌/.test(l));
    expect(excluded).toEqual([expect.stringMatching(/…CK-1.*화면 잠김/), expect.stringMatching(/…OD-1.*헬퍼 준비 안 됨\(disabled\)/)]);
    expect(logs.join('\n')).not.toMatch(/LOCK-1|GOOD-1/);
  });

  it('실행 중 기기가 빠져 run 이 blocked 로 끝나면 곧바로 다시 보고해 Fleet 에 offline(보고에서 빠짐)으로 보인다', async () => {
    await post('/cycles', { cycleId: 'cl2', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cl2/runs', { targetId: 'android', runId: 'r-lost-dev' });
    let plugged = true;
    const inventory = async () => (plugged ? [dev('GONE-1')] : []);
    const engine = async (a: { device?: string }) => { plugged = false; const h = await fakeEngine(a); h.engine.session!.open = async () => { throw new EngineError('device-unavailable', '기기가 빠짐'); }; return h; };
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-l', pollMs: 10 }, deps({ maxRuns: 1, inventory, createEngine: engine }));
    expect(r.runs[0]!.exitCode).toBe(EXIT.blocked);
    // 서버 TTL 60초라 주기 보고(20초)를 기다리지 않았다: 끝나자마자 보고가 들어가 있어야 한다
    const node = (await (await fetch(`${url}/fleet`)).json() as FleetView).nodes.find((n) => n.agentId === 'node-l')!;
    expect(node.devices).toMatchObject([{ id: 'GONE-1', state: 'offline', reason: '보고에서 빠짐' }]);
    expect((await view('cl2')).runs[0]).toMatchObject({ state: 'infra-failed' });
  });
});

describe('runDaemon · 보고 사슬', () => {
  it('run 이 끝나 바로 보고할 때 주기 보고가 진행 중이어도 보고 사슬은 하나다(타이머가 둘로 늘지 않는다)', async () => {
    await cp!.close();
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000 }); // 보고 간격 1초
    url = `http://127.0.0.1:${srv.port}`;
    try {
      await post('/cycles', { cycleId: 'cr', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
      await post('/cycles/cr/runs', { targetId: 'android' });
      const puts: number[] = [];
      const counting: typeof fetch = (input, init) => { if (String(input).includes('/fleet/nodes/') && init?.method === 'PUT') puts.push(Date.now()); return fetch(input, init); };
      const device = { id: 'SER-R', platform: 'android' as const, model: 'm', osVersion: '13', connection: 'device' as const, helper: 'ready' as const, locked: false };
      // 읽기가 느리다(700ms): run 이 끝나는 순간 주기 보고가 아직 읽는 중이게 만든다
      let reading = 0;
      const inventory = async () => { reading++; try { await new Promise((r) => setTimeout(r, 700)); return [device]; } finally { reading--; } };
      const aborter = new AbortController();
      // run 은 blocked 로 끝난다(옛 코드는 이때만 바로 보고했다 — 사슬이 둘로 늘던 경로)
      // 엔진 준비를 주기 보고의 읽기가 진행 중일 때까지 미룬다: run 이 끝나는 순간 그 보고가 아직 끝나지 않았음을 보장한다(타이밍에 맡기지 않는다)
      const blockedEngine = async (a: { device?: string }) => {
        await until(() => reading > 0, 5_000);
        const h = await fakeEngine(a); h.engine.session!.open = async () => { throw new EngineError('device-unavailable', '기기 없음'); }; return h;
      };
      const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-r', pollMs: 50 }, deps({ signal: aborter.signal, inventory, fetch: counting, createEngine: blockedEngine }));
      await until(async () => (await view('cr')).state === 'finished', 8_000);
      const from = Date.now();
      await new Promise((r) => setTimeout(r, 5_100));
      aborter.abort();
      await p;
      const inWindow = puts.filter((t) => t >= from).length;
      // 사슬 하나면 주기는 1초 + 읽기 0.7초 ≈ 1.7초라 5.1초에 3~4번, 둘로 늘면 6번 이상
      expect(inWindow).toBeGreaterThanOrEqual(2);
      expect(inWindow).toBeLessThanOrEqual(4);
    } finally { await srv.close(); cp = undefined; }
  }, 20_000);
});

describe('runDaemon · 조건 타깃', () => {
  it('--targets 없이 띄운 데몬이 조건(Android 13 이상)에 맞는 기기로 Run 을 받고, 맞지 않는 조건의 Run 은 받지 않는다', async () => {
    await post('/cycles', { cycleId: 'cs', build: 'b', targets: [{ id: 'a13', platform: 'android', osVersion: { min: '13' } }, { id: 'a15', platform: 'android', osVersion: { min: '15' } }], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cs/runs', { targetId: 'a15', runId: 'r-15' }); // 먼저 등록됐지만 맞는 기기가 없다
    await post('/cycles/cs/runs', { targetId: 'a13', runId: 'r-13' });
    const dev = (id: string, osVersion: string) => ({ id, platform: 'android' as const, model: 'SM-N981N', osVersion, connection: 'device' as const, helper: 'ready' as const, locked: false });
    const used: Array<string | undefined> = [];
    const r = await runDaemon({ controlPlane: url, targets: [], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-s', pollMs: 10 }, deps({ maxRuns: 1, inventory: async () => [dev('OLD-12', '12'), dev('NEW-14', '14')], createEngine: async (a) => { used.push(a.device); return fakeEngine(a); } }));
    expect(r.runs).toEqual([{ runId: 'r-13', targetId: 'a13', exitCode: EXIT.ok }]);
    expect(used).toEqual(['NEW-14']);
    const v = await view('cs');
    expect(v.runs.map((x) => [x.runId, x.state])).toEqual([['r-15', 'queued'], ['r-13', 'finished']]);
    expect(logs.join('\n')).toMatch(/target a13, 기기 …W-14/);
  });
});

describe('runDaemon · 구버전 control-plane', () => {
  it('targetId 없는 클레임을 400 으로 거절하는 구버전 서버면 이름 타깃마다 청하는 방식으로 바꿔 Run 을 받는다', async () => {
    await post('/cycles', { cycleId: 'cv', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/cv/runs', { targetId: 'android', runId: 'r-old' });
    // 구버전 흉내: 본문에 targetId 가 없는 클레임은 400
    const oldServer: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/runs/claim') && !String(init?.body ?? '').includes('"targetId"')) return new Response(JSON.stringify({ error: 'targetId 와 agentId(문자열)가 필요함' }), { status: 400 });
      return fetch(input, init);
    };
    const r = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache'), agent: 'node-v', pollMs: 10 }, deps({ maxRuns: 1, fetch: oldServer }));
    expect(r.runs).toEqual([{ runId: 'r-old', targetId: 'android', exitCode: EXIT.ok }]);
    expect(logs.filter((l) => /구버전으로 보임/.test(l))).toHaveLength(1);
  });
});

describe('runDaemon · --fake-devices', () => {
  const file = () => path.join(spool, 'fake.json');
  const run = (agent: string, extra: Record<string, unknown> = {}) => runDaemon({ controlPlane: url, targets: [], tests: fixtures, engine: 'fake', fakeDevices: file(), spool, helperCache: path.join(spool, 'hc'), agent, pollMs: 50, ...extra } as Parameters<typeof runDaemon>[0], deps({ signal: AbortSignal.timeout(300) }));

  it('fake 엔진 데몬이 파일의 가짜 기기들을 보고한다', async () => {
    fs.writeFileSync(file(), JSON.stringify([
      { id: 'F-A13', platform: 'android', model: 'FakePhone', osVersion: '13', connection: 'device', helper: 'ready', locked: false },
      { id: 'F-IOS', platform: 'ios', model: 'FakePad', osVersion: '17', connection: 'device' },
    ]));
    await run('node-fd');
    const f = (await (await fetch(`${url}/fleet`)).json()) as FleetView;
    expect(f.nodes.find((n) => n.agentId === 'node-fd')!.devices.map((d) => [d.id, d.platform, d.state])).toEqual([['F-A13', 'android', 'idle'], ['F-IOS', 'ios', 'idle']]);
  });

  it('잘못된 목록·없는 파일은 설정 오류이고, 네트워크를 건드리기 전에(스풀 이어 보내기보다 먼저) 실패한다', async () => {
    fs.writeFileSync(file(), JSON.stringify([{ id: 'X', platform: 'windows' }]));
    await expect(run('node-fe')).rejects.toThrow(/--fake-devices 가 올바르지 않음/);
    fs.rmSync(file());
    let touched = 0;
    const counting: typeof fetch = (input, init) => { touched++; return fetch(input, init); };
    await expect(runDaemon({ controlPlane: url, targets: [], tests: fixtures, engine: 'fake', fakeDevices: file(), spool, helperCache: path.join(spool, 'hc'), agent: 'node-fm', pollMs: 50 }, deps({ signal: AbortSignal.timeout(300), fetch: counting }))).rejects.toThrow(/--fake-devices 파일을 읽지 못함/);
    expect(touched).toBe(0);
  });

  it('mobile 엔진에는 쓸 수 없다(CLI 와 라이브러리 모두)', async () => {
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--tests', 'd', '--engine', 'mobile', '--fake-devices', file()], {})).toThrow(/--engine fake/);
    await expect(run('node-fx', { engine: 'mobile' })).rejects.toThrow(/--engine fake/);
  });
});
