// @vitest-environment node
// 워커 모드(device-fleet 04): 실제 bin 을 워커로 띄워 가짜 기기 3대에서 Run 3개가 겹쳐 돈다. 워커 하나를 죽여도 나머지는 끝나고, 종료 신호는 세 run 모두에 전파된다.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type RunningControlPlane, type CycleView } from '@sinclair/control-plane';
import { runDaemon, runInWorker, parseDaemonArgs, EXIT } from '../src/index.ts';
import { spawn } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '../bin/sinclair-agent.mjs');
const SLOW = path.resolve(import.meta.dirname, 'fixtures/slow');
// bin 의 재실행 셸을 거치지 않게 변환 플래그를 직접 준다: 셸은 IPC 를 손자에게 전달하지 않는다(실제 데몬도 자기 execArgv 를 넘겨 같은 길로 띄운다 — main.ts)
const WORKER = [process.execPath, '--experimental-transform-types', '--no-warnings=ExperimentalWarning', BIN];
let cp: RunningControlPlane | undefined;
let url: string;
let spool: string;
const logs: string[] = [];
const saved = { ms: process.env.SINCLAIR_E2E_SLOW_MS, count: process.env.SINCLAIR_E2E_SLOW_COUNT };
beforeAll(() => { process.env.SINCLAIR_E2E_SLOW_MS = '1500'; process.env.SINCLAIR_E2E_SLOW_COUNT = '2'; });
afterAll(() => { for (const [k, v] of [['SINCLAIR_E2E_SLOW_MS', saved.ms], ['SINCLAIR_E2E_SLOW_COUNT', saved.count]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
beforeEach(async () => { cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'x', leaseTtlMs: 60_000 }); url = `http://127.0.0.1:${cp.server.port}`; spool = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-workers-')); logs.length = 0; });
afterEach(async () => { if (process.env.DEBUG_WORKERS) console.log("LOGS\n" + logs.join("\n")); await cp?.close(); fs.rmSync(spool, { recursive: true, force: true }); });

const post = (p: string, body: unknown) => fetch(`${url}${p}`, { method: 'POST', body: JSON.stringify(body) });
const view = async (id: string) => (await (await fetch(`${url}/cycles/${id}`)).json()) as CycleView;
const runView = async (id: string) => (await (await fetch(`${url}/runs/${id}`)).json()) as { state: string; startedAt?: string; finishedAt?: string };
const until = async (cond: () => Promise<boolean> | boolean, limitMs = 20_000) => { const t = Date.now(); while (!(await cond()) && Date.now() - t < limitMs) await new Promise((r) => setTimeout(r, 50)); };
const dev = (id: string) => ({ id, platform: 'android' as const, model: 'FakeEngine', osVersion: '13', connection: 'device' as const, helper: 'ready' as const, locked: false });
const inventory = async () => [dev('W-1'), dev('W-2'), dev('W-3')];
const args = (agent: string) => ({ controlPlane: url, targets: ['android'], tests: SLOW, engine: 'fake' as const, spool, helperCache: path.join(spool, 'hc'), agent, pollMs: 100 });
async function threeRuns(cycleId: string): Promise<void> {
  await post('/cycles', { cycleId, build: 'b', targets: ['android'], suite: { tests: SLOW } });
  for (const r of ['r1', 'r2', 'r3']) await post(`/cycles/${cycleId}/runs`, { targetId: 'android', runId: `${cycleId}-${r}` });
}

describe('runDaemon · 워커 모드', () => {
  it('기기 3대 노드가 Run 3개를 서로 다른 기기에서 동시에 돌린다(실행 시간이 겹친다)', async () => {
    await threeRuns('w');
    const pids: number[] = [];
    const summary = await runDaemon(args('node-w'), { log: (l) => logs.push(l), inventory, workerCommand: WORKER, maxRuns: 3, onWorkerSpawn: (_r, pid) => pids.push(pid) });
    expect(summary.runs.map((r) => r.exitCode)).toEqual([EXIT.ok, EXIT.ok, EXIT.ok]);
    expect(new Set(pids).size).toBe(3); // run 마다 다른 워커 프로세스
    expect(pids).not.toContain(process.pid);
    const v = await view('w');
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(new Set(v.runs.map((r) => r.lease?.deviceId))).toEqual(new Set(['W-1', 'W-2', 'W-3']));
    const spans = await Promise.all(v.runs.map((r) => runView(r.runId)));
    const latestStart = Math.max(...spans.map((x) => Date.parse(x.startedAt!)));
    const earliestEnd = Math.min(...spans.map((x) => Date.parse(x.finishedAt!)));
    expect(latestStart).toBeLessThan(earliestEnd); // 셋이 동시에 돌고 있던 순간이 있다
    expect(logs.some((l) => /^\[run …/.test(l))).toBe(true); // 워커 로그는 run 을 붙여 데몬으로 온다
    // 세 워커가 같은 스풀 디렉터리를 썼지만 run 마다 따로 써서 다 보내고 치웠다(서로의 스풀을 건드렸다면 남거나 중복 거부가 났다)
    expect(fs.readdirSync(spool).filter((f) => !f.startsWith('hc'))).toEqual([]);
    expect(logs.join('\n')).not.toMatch(/rejected [1-9]|duplicate [1-9]/);
  }, 60_000);

  it('워커 하나를 SIGKILL 해도 나머지 두 run 은 끝나고, 죽은 run 은 결과 없이(4) 남아 버려진 Run 규칙을 기다린다', async () => {
    await threeRuns('k');
    const pids = new Map<string, number>();
    const p = runDaemon(args('node-k'), { log: (l) => logs.push(l), inventory, workerCommand: WORKER, maxRuns: 3, onWorkerSpawn: (r, pid) => pids.set(r, pid) });
    await until(async () => (await runView('k-r1')).state === 'running');
    process.kill(pids.get('k-r1')!, 'SIGKILL');
    const summary = await p;
    const byRun = Object.fromEntries(summary.runs.map((r) => [r.runId, r.exitCode]));
    expect(byRun).toEqual({ 'k-r1': EXIT.incomplete, 'k-r2': EXIT.ok, 'k-r3': EXIT.ok });
    expect((await runView('k-r1')).state).toBe('running'); // run.finished 가 없다: lease 만료 + 유예 뒤 control-plane 이 정리한다
    expect(logs.some((l) => /워커가 결과 없이 끝남/.test(l))).toBe(true);
  }, 60_000);

  it('데몬 종료 신호는 세 워커 모두에 취소로 전파된다: 각자 현재 테스트를 마치고 cancelled(5)', async () => {
    await threeRuns('c');
    const aborter = new AbortController();
    const p = runDaemon(args('node-c'), { log: (l) => logs.push(l), inventory, workerCommand: WORKER, signal: aborter.signal });
    await until(async () => (await Promise.all(['c-r1', 'c-r2', 'c-r3'].map(runView))).every((x) => x.state === 'running'));
    aborter.abort();
    const summary = await p;
    expect(summary.runs.map((r) => [r.exitCode, r.cancelled])).toEqual([[EXIT.cancelled, '종료 신호'], [EXIT.cancelled, '종료 신호'], [EXIT.cancelled, '종료 신호']]);
    const v = await view('c');
    expect(v.runs.map((r) => r.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    // "현재 테스트까지": 도는 중이던 첫 테스트는 끝까지 돌아 통과하고, 두 번째는 시작하지 않아 취소 skipped
    for (const r of v.runs) {
      const rv = (await (await fetch(`${url}/runs/${r.runId}`)).json()) as { attempts: Array<{ testId: string; result: string; errorCode?: string }> };
      expect(rv.attempts.map((a) => [a.testId, a.result, a.errorCode])).toEqual([['느린 테스트 1', 'passed', undefined], ['느린 테스트 2', 'skipped', 'cancelled']]);
    }
  }, 60_000);

  it('데몬이 죽으면(IPC 끊김) 워커도 곧바로 끝나 run.finished 없이 남는다 — 재시도 정책이 버려진 Run 으로 대체할 수 있게', async () => {
    const { spawn } = await import('node:child_process');
    await post('/cycles', { cycleId: 'd', build: 'b', targets: ['android'], suite: { tests: SLOW } });
    await post('/cycles/d/runs', { targetId: 'android', runId: 'd-r1' });
    // 워커를 직접 띄우고 start 를 보낸 뒤 IPC 를 끊는다(데몬 크래시 흉내)
    const child = spawn(WORKER[0]!, [...WORKER.slice(1), '__worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, SINCLAIR_AGENT_WORKER: '1' } });
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await new Promise((r) => child.on('spawn', r));
    child.send({ type: 'start', args: { ...args('node-d'), cycle: 'd', target: 'android', run: 'd-r1', tests: SLOW, device: 'W-1' }, run: { runId: 'd-r1', cycleId: 'd', targetId: 'android' }, files: [path.join(SLOW, 'slow.sinclair.ts')] });
    await until(async () => (await runView('d-r1')).state === 'running');
    child.disconnect();
    expect(await exited).toBe(143);
    await new Promise((r) => setTimeout(r, 2_000)); // 남은 테스트가 돌았다면 이 사이 run.finished 가 들어왔을 것이다
    expect((await runView('d-r1')).state).toBe('running');
  }, 30_000);

  it('--concurrency 2 면 기기가 3대여도 동시에 둘까지만 돈다(셋째는 하나가 끝난 뒤 시작)', async () => {
    await threeRuns('q');
    const summary = await runDaemon({ ...args('node-q'), concurrency: 2 }, { log: (l) => logs.push(l), inventory, workerCommand: WORKER, maxRuns: 3 });
    expect(summary.runs.map((r) => r.exitCode)).toEqual([EXIT.ok, EXIT.ok, EXIT.ok]);
    const spans = (await Promise.all(['q-r1', 'q-r2', 'q-r3'].map(runView))).map((x) => [Date.parse(x.startedAt!), Date.parse(x.finishedAt!)] as const);
    // 어느 순간에도 겹친 run 이 둘 이하: 각 시작 시각에 돌고 있던 run 수를 센다
    const maxOverlap = Math.max(...spans.map(([s]) => spans.filter(([a, b]) => a <= s && s < b).length));
    expect(maxOverlap).toBe(2);
  }, 60_000);

  it('heartbeat 가 lease 상실(409)이면 그 워커에만 취소가 가서 cancelled(lease 를 잃음), 다른 run 은 그대로 끝난다', async () => {
    await cp!.close();
    cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'x', leaseTtlMs: 3_000 }); // heartbeat 1초
    url = `http://127.0.0.1:${cp.server.port}`;
    await post('/cycles', { cycleId: 'l', build: 'b', targets: ['android'], suite: { tests: SLOW } });
    for (const r of ['r1', 'r2']) await post('/cycles/l/runs', { targetId: 'android', runId: `l-${r}` });
    const lost: typeof fetch = async (input, init) => (String(input).endsWith('/runs/l-r1/heartbeat') ? new Response(JSON.stringify({ code: 'not-owner' }), { status: 409 }) : fetch(input, init));
    const summary = await runDaemon(args('node-l'), { log: (l) => logs.push(l), inventory, workerCommand: WORKER, maxRuns: 2, fetch: lost });
    const byRun = Object.fromEntries(summary.runs.map((r) => [r.runId, [r.exitCode, r.cancelled]]));
    expect(byRun).toEqual({ 'l-r1': [EXIT.cancelled, 'lease 를 잃음'], 'l-r2': [EXIT.ok, undefined] });
  }, 60_000);

  it('워커를 띄우지 못하면(실행 파일 없음) 영영 기다리지 않고 결과 없음(4)으로 끝난다', async () => {
    const lines: string[] = [];
    const code = await runInWorker(['/nonexistent/node-binary'], { type: 'start', args: { ...args('x'), cycle: 'c', target: 't', run: 'r' }, run: { runId: 'r', cycleId: 'c', targetId: 't' }, files: [] }, { log: (l) => lines.push(l), signal: new AbortController().signal });
    expect(code).toBe(EXIT.incomplete);
    expect(lines.join('\n')).toMatch(/워커를 띄우지 못함/);
  });

  it('start 를 받지 못한 워커는 시간 제한 뒤 스스로 끝난다(IPC 를 전달하지 않는 셸을 거쳐 잘못 띄워진 경우)', async () => {
    const child = spawn(WORKER[0]!, [...WORKER.slice(1), '__worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, SINCLAIR_AGENT_WORKER: '1', SINCLAIR_AGENT_WORKER_START_TIMEOUT_MS: '500' } });
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(EXIT.config);
  }, 20_000);

  it('--concurrency / SINCLAIR_AGENT_CONCURRENCY 는 1 이상의 정수', () => {
    const base = ['--control-plane', 'http://x', '--tests', 'd'];
    expect(parseDaemonArgs([...base, '--concurrency', '2'], { HOME: '/h' }, 'linux')).toMatchObject({ concurrency: 2 });
    expect(parseDaemonArgs(base, { HOME: '/h', SINCLAIR_AGENT_CONCURRENCY: '3' }, 'linux')).toMatchObject({ concurrency: 3 });
    expect(() => parseDaemonArgs([...base, '--concurrency', '0'], {})).toThrow(/concurrency/);
  });
});
