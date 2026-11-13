// @vitest-environment node
// 녹화 캐시(recording-cache 05): runner-agent 의 HTTP 저장소(control-plane /cache)와 --cache. 노드 A 가 녹화하면 노드 B 가 모델 없이 재생한다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cacheStoreContractSuite } from '@sinclair/protocol/testing';
import { scriptedExecutor } from '@sinclair/agent';
import { startControlPlane, type RunningControlPlane } from '@sinclair/control-plane';
import { createHttpCacheStore, parseRunArgs, parseDaemonArgs, runOnce, EXIT, AgentConfigError } from '../src/index.ts';

const MEMORY = { host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' } as const;
let cp: RunningControlPlane;
let url: string;
beforeEach(async () => { cp = await startControlPlane(MEMORY); url = `http://127.0.0.1:${cp.server.port}`; });
afterEach(async () => { await cp.close(); });

cacheStoreContractSuite('runner-agent HTTP → control-plane', () => createHttpCacheStore(url));

describe('createHttpCacheStore', () => {
  it('서버가 5xx 거나 닿지 않으면 던진다(러너가 미스·경고로 다룬다)', async () => {
    const s500 = createHttpCacheStore(url, async () => new Response('x', { status: 500 }));
    await expect(s500.read('d'.repeat(64))).rejects.toThrow(/500/);
    const down = createHttpCacheStore('http://127.0.0.1:1');
    await expect(down.read('d'.repeat(64))).rejects.toThrow();
  });
});

describe('--cache', () => {
  it('run·daemon 모두 off|read-only|read-write|strict, 기본 read-write, 환경변수 SINCLAIR_AGENT_CACHE, 그 밖은 설정 오류', () => {
    const base = ['--control-plane', url, '--cycle', 'c', '--target', 't', '--tests', '.'];
    expect(parseRunArgs(base, {}).cache).toBe('read-write');
    expect(parseRunArgs([...base, '--cache', 'strict'], {}).cache).toBe('strict');
    expect(parseRunArgs(base, { SINCLAIR_AGENT_CACHE: 'off' }).cache).toBe('off');
    expect(() => parseRunArgs([...base, '--cache', 'on'], {})).toThrow(AgentConfigError);
    expect(parseDaemonArgs(['--control-plane', url, '--tests', '.', '--cache', 'read-only'], {}).cache).toBe('read-only');
  });
});

describe('노드 A 녹화 → 노드 B 재생', () => {
  let spool: string;
  beforeEach(() => { spool = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-agent-cache-')); });
  afterEach(() => fs.rmSync(spool, { recursive: true, force: true }));
  const tests = path.resolve(import.meta.dirname, 'fixtures', 'agent-login');
  const args = (cycle: string, agent: string) => ({ controlPlane: url, cycle, target: 'android', tests, engine: 'fake' as const, spool: path.join(spool, agent), helperCache: path.join(spool, 'helper-cache'), agent });
  const stepsOf = async (cycle: string) => {
    const v = await (await fetch(`${url}/cycles/${cycle}`)).json() as { verdict: string; runs: Array<{ runId: string }> };
    const run = await (await fetch(`${url}/runs/${v.runs[0]!.runId}`)).json() as { attempts: Array<{ steps: Array<{ kind: string; cache?: string; modelCalls: number }> }> };
    return { verdict: v.verdict, act: run.attempts[0]!.steps.find((s) => s.kind === 'act')! };
  };

  it('첫 Cycle 에서 노드 A 가 라이브로 돌아 control-plane 에 녹화하고, 다음 Cycle 에서 노드 B 는 모델 없이 재생해 verified', async () => {
    for (const c of ['c1', 'c2']) await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: c, build: 'b', targets: ['android'] }) });
    const live = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '환영합니다' } }]);
    expect(await runOnce(args('c1', 'node-a'), { log: () => {}, agent: { executor: live } })).toBe(EXIT.ok);
    expect(await stepsOf('c1')).toMatchObject({ verdict: 'verified', act: { cache: 'live', modelCalls: 2 } });
    const noModel = { next: () => Promise.reject(new Error('모델을 부르면 안 된다')) };
    expect(await runOnce(args('c2', 'node-b'), { log: () => {}, agent: { executor: noModel } })).toBe(EXIT.ok);
    expect(await stepsOf('c2')).toMatchObject({ verdict: 'verified', act: { cache: 'replayed', modelCalls: 0 } });
  });

  it('--cache off 면 저장소를 쓰지 않는다(다음 실행도 라이브)', async () => {
    for (const c of ['c1', 'c2']) await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: c, build: 'b', targets: ['android'] }) });
    const live = () => scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '환영합니다' } }]);
    await runOnce({ ...args('c1', 'node-a'), cache: 'off' }, { log: () => {}, agent: { executor: live() } });
    await runOnce(args('c2', 'node-b'), { log: () => {}, agent: { executor: live() } });
    expect((await stepsOf('c2')).act).toMatchObject({ cache: 'live', modelCalls: 2 });
  });
});
