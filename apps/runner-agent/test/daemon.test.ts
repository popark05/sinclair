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
const deps = (extra: Partial<DaemonDeps> = {}): DaemonDeps => ({ log: (l) => logs.push(l), createEngine: fakeEngine, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), ...extra });
const post = (p: string, body: unknown) => fetch(`${url}${p}`, { method: 'POST', body: JSON.stringify(body) });
const view = async (id: string) => (await (await fetch(`${url}/cycles/${id}`)).json()) as CycleView;

describe('runDaemon', () => {
  it('타깃 2개 Cycle 을 데몬 2개(각 타깃)가 클레임해 채우면 Cycle 이 finished/verified 다. suite.tests 를 따른다', async () => {
    await post('/cycles', { cycleId: 'c1', build: 'b', targets: ['android', 'ios'], suite: { tests: path.join(fixtures, 'only-login') } });
    await post('/cycles/c1/runs', { targetId: 'android' });
    await post('/cycles/c1/runs', { targetId: 'ios' });
    const [a, b] = await Promise.all([
      runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, agent: 'node-a', pollMs: 10 }, deps({ maxRuns: 1 })),
      runDaemon({ controlPlane: url, targets: ['ios'], tests: fixtures, engine: 'fake', spool, agent: 'node-b', pollMs: 10 }, deps({ maxRuns: 1 })),
    ]);
    expect(a.runs).toEqual([{ runId: expect.any(String), targetId: 'android', exitCode: EXIT.ok }]);
    expect(b.runs).toEqual([{ runId: expect.any(String), targetId: 'ios', exitCode: EXIT.ok }]);
    const v = await view('c1');
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(v.runs.map((r) => r.lease?.agentId).sort()).toEqual(['node-a', 'node-b']);
    expect(logs.join('\n')).toMatch(/tests .*only-login/); // Cycle 의 suite 를 썼다(기본 fixtures 가 아니라)
    expect(fs.readdirSync(spool)).toEqual([]); // 스풀은 다 보내고 치워졌다
  });

  it('실패한 run 뒤에도 다음 Run 을 계속 가져가고, 대기 중인 Run 이 없으면 폴링하다가 신호에 멈춘다', async () => {
    await post('/cycles', { cycleId: 'c2', build: 'b', targets: ['android'], suite: { tests: fixtures } }); // 통과 1 + 실패 1
    await post('/cycles/c2/runs', { targetId: 'android', runId: 'r-first' });
    await post('/cycles/c2/runs', { targetId: 'android', runId: 'r-second' });
    const aborter = new AbortController();
    const p = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, agent: 'n', pollMs: 10, timeoutMs: 100 }, deps({ signal: aborter.signal }));
    for (let i = 0; i < 300 && (await view('c2')).runs.some((r) => r.state !== 'finished'); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 60)); // 폴링 한두 번
    aborter.abort();
    const summary = await p;
    expect(summary.stoppedBy).toBe('signal');
    expect(summary.runs.map((r) => [r.runId, r.exitCode])).toEqual([['r-first', EXIT.testsFailed], ['r-second', EXIT.testsFailed]]);
    expect(logs.at(-1)).toBe('데몬 종료');
  });

  it('lease 가 만료된 Run 은 다른 데몬이 가져가고, 끝난 뒤 heartbeat 는 멈춘다', async () => {
    await cp!.close();
    let now = Date.parse('2026-11-08T00:00:00.000Z');
    const srv = await serveControlPlane(createMemoryEventStore(), { leaseTtlMs: 3_000, now: () => now });
    url = `http://127.0.0.1:${srv.port}`;
    try {
      await post('/cycles', { cycleId: 'c3', build: 'b', targets: ['android'], suite: { tests: path.join(fixtures, 'only-login') } });
      await post('/cycles/c3/runs', { targetId: 'android', runId: 'r-lease' });
      // 첫 에이전트가 클레임만 하고 죽은 상황: 엔진 생성이 영영 끝나지 않는 deps 로 흉내 내고 중단한다
      const dead = new AbortController();
      const stuck = runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, agent: 'dead-agent', pollMs: 10 }, deps({ signal: dead.signal, createEngine: () => new Promise(() => {}) }));
      for (let i = 0; i < 100 && !(await view('c3')).runs[0]!.lease; i++) await new Promise((r) => setTimeout(r, 10));
      expect((await view('c3')).runs[0]!.lease?.agentId).toBe('dead-agent');
      // 만료 전에는 못 가져간다
      const early = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, agent: 'live-agent', pollMs: 10 }, deps({ maxRuns: 1, signal: AbortSignal.timeout(100) }));
      expect(early.runs).toEqual([]);
      now += 3_000; // 만료
      const late = await runDaemon({ controlPlane: url, targets: ['android'], tests: fixtures, engine: 'fake', spool, agent: 'live-agent', pollMs: 10 }, deps({ maxRuns: 1 }));
      expect(late.runs).toEqual([{ runId: 'r-lease', targetId: 'android', exitCode: EXIT.ok }]);
      expect((await view('c3'))).toMatchObject({ state: 'finished', verdict: 'verified', runs: [{ lease: { agentId: 'live-agent' } }] });
      dead.abort(); // 멈춘 데몬은 엔진 promise 가 영영 안 끝나므로 기다리지 않는다
      void stuck;
    } finally {
      await srv.close();
      cp = undefined;
    }
  });
});

describe('parseDaemonArgs', () => {
  it('필수값·타깃 목록·기본값, 잘못된 값', () => {
    expect(parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'android, ios', '--tests', 'd', '--poll', '100'], { HOME: '/h' }, 'linux')).toEqual({ controlPlane: 'http://x', targets: ['android', 'ios'], tests: 'd', engine: 'mobile', spool: '/h/.local/share/sinclair/spool', pollMs: 100 });
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--tests', 'd'], {})).toThrow(/targets/);
    expect(() => parseDaemonArgs(['--control-plane', 'http://x', '--targets', 'a', '--tests', 'd', '--poll', 'x'], {})).toThrow(AgentConfigError);
    expect(parseDaemonArgs(['--help'], {})).toEqual({ help: true });
  });
});
