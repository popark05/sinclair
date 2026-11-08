// @vitest-environment node
// runDaemon: 인프로세스 control-plane + FakeEngine. 타깃 2개 Cycle 을 데몬 2개가 채우고, 실패 뒤에도 계속 돌며, lease 가 만료되면 다른 에이전트가 가져간다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, serveControlPlane, createMemoryEventStore, type RunningControlPlane, type CycleView } from '@sinclair/control-plane';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { runDaemon, parseDaemonArgs, AgentConfigError, EXIT, type DaemonDeps } from '../src/index.ts';

const MEMORY = { host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' } as const;
const fixtures = path.resolve(import.meta.dirname, 'fixtures');
let cp: RunningControlPlane | undefined;
let url: string;
let spool: string;
const logs: string[] = [];
beforeEach(async () => { cp = await startControlPlane(MEMORY); url = `http://127.0.0.1:${cp.server.port}`; spool = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-daemon-')); logs.length = 0; });
afterEach(async () => { await cp?.close(); cp = undefined; fs.rmSync(spool, { recursive: true, force: true }); });

const fakeEngine = async () => { const e = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) }); return { engine: e, dispose: () => e.dispose(), deviceId: 'fake' }; };
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
      expect(stuckSummary.runs).toEqual([{ runId: 'r-lease', targetId: 'android', exitCode: EXIT.blocked }]);
    } finally {
      await srv.close();
      cp = undefined;
    }
  });

});

describe('parseDaemonArgs', () => {
  it('필수값·타깃 목록·기본값, 잘못된 값', () => {
    expect(parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'android, ios', '--tests', 'd', '--poll', '100'], { HOME: '/h' }, 'linux')).toEqual({ controlPlane: 'http://x', targets: ['android', 'ios'], tests: 'd', engine: 'mobile', spool: '/h/.local/share/sinclair/spool', helperCache: '/h/.local/share/sinclair/cache/helper', pollMs: 100 });
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'a', '--tests', 'd', '--poll', '50'], {})).toThrow(/100 이상/);
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--tests', 'd'], {})).toThrow(/targets/);
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'a', '--tests', 'd', '--poll', 'x'], {})).toThrow(AgentConfigError);
    expect(parseDaemonArgs(['--help'], {})).toEqual({ help: true });
  });
});
