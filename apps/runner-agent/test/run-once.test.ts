// @vitest-environment node
// runOnce: 인프로세스 control-plane + FakeEngine 으로 Run 등록 → 실행 → 보고 → GET /cycles/:id 가 finished. 종료 코드 0/1/2/3.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import { FakeEngine, LOGIN_SCREEN, withDeviceUnavailable } from '@sinclair/protocol/testing';
import { startControlPlane, type RunningControlPlane, type CycleView } from '@sinclair/control-plane';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { runOnce, executeRun, collectTestFiles, main, createSpoolReporter, EXIT, type RunOnceDeps, type RunArgs } from '../src/index.ts';

/** 메모리 저장소 설정. db 는 memory 모드에서 쓰이지 않지만 타입상 필수 */
const MEMORY = { host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' } as const;
/** 테스트용 스풀 Reporter: 재시도 예산을 짧게 */
const createSpoolReporterForTest = (a: RunArgs, r: { runId: string; cycleId: string; targetId: string }) =>
  createSpoolReporter({ dir: a.spool, runId: r.runId, controlPlane: a.controlPlane, cycleId: r.cycleId, targetId: r.targetId, backoffMs: 5, maxBackoffMs: 20, maxRetryMs: 200, flushIntervalMs: 20 });

let cp: RunningControlPlane;
let url: string;
const logs: string[] = [];
const deps = (): RunOnceDeps => ({ log: (line) => logs.push(line) });
beforeEach(async () => { cp = await startControlPlane(MEMORY); url = `http://127.0.0.1:${cp.server.port}`; logs.length = 0; });
afterEach(async () => { await cp.close(); });

const fixtures = path.resolve(import.meta.dirname, 'fixtures');
let spool: string;
beforeEach(() => { spool = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-agent-spool-')); });
afterEach(() => fs.rmSync(spool, { recursive: true, force: true }));
const createCycle = async (cycleId = 'c1') => { await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId, build: 'b', targets: ['android'] }) }); };
const view = async (cycleId = 'c1') => (await (await fetch(`${url}/cycles/${cycleId}`)).json()) as CycleView;

describe('runOnce', () => {
  it('Run 을 발급받아 테스트를 돌리고 보고하면 Cycle 이 finished/verified 이고 종료 코드 0', async () => {
    await createCycle();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache') }, deps());
    expect(code).toBe(EXIT.ok);
    const v = await view();
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(Object.keys(v.matrix)).toEqual(['로그인 버튼을 누르면 환영 문구가 보인다']);
    expect(logs.join('\n')).toMatch(/run .* 등록/);
    expect(logs.join('\n')).toMatch(/passed 1.*failed 0/);
  });

  it('실패한 테스트가 있으면 1, 테스트 파일은 이름순이고 *.sinclair.ts 만 모은다', async () => {
    await createCycle();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: fixtures, engine: 'fake', timeoutMs: 200, spool, helperCache: path.join(spool, 'helper-cache') }, deps());
    expect(code).toBe(EXIT.testsFailed);
    const v = await view();
    expect(Object.keys(v.matrix)).toEqual(['없는 문구를 찾다 실패한다', '로그인 버튼을 누르면 환영 문구가 보인다']); // failing.sinclair.ts 가 login 보다 앞
    expect(v.verdict).toBe('blocked');
  });

  it('--retries 로 첫 시도만 실패하는 테스트가 통과하고(0), 없으면 실패(1)', async () => {
    await createCycle('c1');
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'flaky'), engine: 'fake', timeoutMs: 200, spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.testsFailed);
    await createCycle('c2');
    expect(await runOnce({ controlPlane: url, cycle: 'c2', target: 'android', tests: path.join(fixtures, 'flaky'), engine: 'fake', timeoutMs: 200, retries: 1, spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.ok);
    expect(await view('c2')).toMatchObject({ verdict: 'verified', matrix: { '첫 시도에만 실패한다': { android: { verdict: 'passed-flaky' } } } });
  });

  it('--run 으로 지정한 Run 을 쓰고, 끝난 Cycle 이나 모르는 Cycle 은 설정 오류 3', async () => {
    await createCycle();
    await fetch(`${url}/cycles/c1/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'r-given' }) });
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-given', spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.ok);
    expect((await view()).runs.map((r) => r.runId)).toEqual(['r-given']);
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: fixtures, engine: 'fake', timeoutMs: 200, spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.config); // 끝난 Cycle: 409
    expect(await runOnce({ controlPlane: url, cycle: '없음', target: 'android', tests: fixtures, engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.config);
    expect(logs.join('\n')).toMatch(/409|이미/);
  });

  it('기기 불가(device-unavailable)면 blocked 로 보고하고 2', async () => {
    await createCycle();
    const broken = withDeviceUnavailable(new FakeEngine({ root: LOGIN_SCREEN }));
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', agent: 'node-7', spool, helperCache: path.join(spool, 'helper-cache') }, { ...deps(), createEngine: async () => ({ engine: broken, dispose: async () => {} }) });
    expect(code).toBe(EXIT.blocked);
    const v = await view();
    expect(v).toMatchObject({ verdict: 'blocked', runs: [{ state: 'infra-failed' }] });
    const runView = (await (await fetch(`${url}/runs/${v.runs[0]!.runId}`)).json()) as { agentId?: string };
    expect(runView.agentId).toBe('node-7');
  });

  it('엔진을 못 만들면(기기 없음) run.started + infra-failed 만 보고하고 2 — Cycle 에 blocked 가 드러난다', async () => {
    await createCycle();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache') }, { ...deps(), createEngine: async () => { throw new Error('꽂힌 Android 기기가 없음'); } });
    expect(code).toBe(EXIT.blocked);
    expect(await view()).toMatchObject({ state: 'finished', verdict: 'blocked', runs: [{ state: 'infra-failed' }] });
    expect(logs.join('\n')).toMatch(/기기 불가.*꽂힌 Android 기기가 없음/);
  });

  it('--run 을 주고 끝난 Cycle 에 실행하면 재사용이 아니라 설정 오류 3 이고 이벤트를 보내지 않는다', async () => {
    await createCycle();
    await fetch(`${url}/cycles/c1/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'r-done' }) });
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-done', spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.ok);
    const before = await (await fetch(`${url}/runs/r-done`)).text();
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-done', spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.config);
    expect(logs.join('\n')).toMatch(/cycle-finished/);
    expect(await (await fetch(`${url}/runs/r-done`)).text()).toBe(before);
  });

  it('--run 이 있고 서버에 닿지 않으면 등록 없이 진행해 스풀에 남긴다(서버가 거부하면 3)', async () => {
    await cp.close();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-offline', spool, helperCache: path.join(spool, 'helper-cache') }, { ...deps(), createReporter: (a, r) => createSpoolReporterForTest(a, r) });
    expect(code).toBe(EXIT.ok);
    expect(logs.join('\n')).toMatch(/닿지 않아 지정된 run r-offline 으로 진행/);
    expect(fs.readdirSync(spool).sort()).toEqual(['r-offline.jsonl', 'r-offline.meta.json']);
    cp = await startControlPlane(MEMORY); // afterEach 의 close 용
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.config); // --run 없이는 등록이 필요하다
  });

  it('테스트 디렉터리가 없거나 비어 있으면 설정 오류 3 이고 Run 을 등록하지 않는다', async () => {
    await createCycle();
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, '없음'), engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache') }, deps())).toBe(EXIT.config);
    expect((await view()).runs).toEqual([]);
  });

  it('기본 Reporter 는 스풀이라 서버가 run 도중 내려가도 이벤트가 남고, resume 명령이 이어 보낸다', async () => {
    await createCycle();
    // Run 을 등록한 뒤 서버를 내린다: 등록은 성공, 이벤트 전송은 실패 → 스풀에 남음
    const reg = await fetch(`${url}/cycles/c1/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'r-spool' }) });
    expect(reg.status).toBe(201);
    const port = cp.server.port;
    await cp.close();
    // 등록은 끝났고 실행 중 서버가 없는 상황 = 데몬이 클레임한 Run 을 executeRun 으로 돌리는 경로
    const files = await collectTestFiles(path.join(fixtures, 'only-login'));
    const code = await executeRun({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', spool, helperCache: path.join(spool, 'helper-cache') }, { runId: 'r-spool', cycleId: 'c1', targetId: 'android' }, files, {
      ...deps(), createReporter: (a, r) => createSpoolReporterForTest(a, r),
    });
    expect(code).toBe(EXIT.ok); // 테스트는 통과했고 전송만 못 했다
    expect(logs.join('\n')).toMatch(/경고: 재시도 예산 안에 다 보내지 못함.*미전송 \d+건/);
    expect(fs.readdirSync(spool).sort()).toEqual(['r-spool.jsonl', 'r-spool.meta.json']); // ack 는 하나도 못 보냈으니 아직 없다

    // 같은 포트로 서버를 올리고 resume (memory 라 등록은 사라졌지만 Ingest 는 runId 를 검사하지 않는다)
    cp = await startControlPlane({ ...MEMORY, port });
    const out: string[] = [];
    const origLog = console.log; console.log = (l: string) => { out.push(String(l)); };
    try { expect(await main(['resume', '--spool', spool], {})).toBe(EXIT.ok); } finally { console.log = origLog; }
    expect(out.join('\n')).toMatch(/r-spool: 완료/);
    expect(fs.readdirSync(spool)).toEqual([]);
    const runView = (await (await fetch(`${url}/runs/r-spool`)).json()) as { state: string; attempts: unknown[] };
    expect(runView).toMatchObject({ state: 'finished' });
    expect(runView.attempts).toHaveLength(1);
  });
});

describe('runOnce · agent.act 실행기(환경변수 설정)', () => {
  let api: http.Server | undefined;
  const requests: string[] = [];
  afterEach(async () => { vi.unstubAllEnvs(); await new Promise((r) => (api ? api.close(r) : r(undefined))); api = undefined; requests.length = 0; });
  /** 가짜 Messages API: tap @e4 → done 순서로 답한다 */
  const fakeClaude = async (): Promise<string> => {
    const turns = [{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '환영합니다 가 보인다' } }];
    api = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        requests.push(raw);
        const t = turns[Math.min(requests.length - 1, turns.length - 1)]!;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'toolu', name: t.name, input: t.input }] }));
      });
    });
    await new Promise<void>((r) => api!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  };
  const args = () => ({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'agent-login'), engine: 'fake' as const, spool, helperCache: path.join(spool, 'helper-cache') });
  const noCredentials = () => {
    for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_FEDERATION_RULE_ID']) vi.stubEnv(v, undefined);
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-no-creds-')));
  };

  it('ANTHROPIC_* 와 SINCLAIR_AGENT_* 로 만든 Claude 실행기가 act 를 돌리고, 스텝의 토큰 사용량이 Run 뷰에 남는다', async () => {
    await createCycle();
    noCredentials();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', await fakeClaude());
    vi.stubEnv('SINCLAIR_AGENT_MODEL', 'claude-opus-5-5');
    expect(await runOnce(args(), deps())).toBe(EXIT.ok);
    expect(JSON.parse(requests[0]!)).toMatchObject({ model: 'claude-opus-5-5' });
    const v = await view();
    expect(v.verdict).toBe('verified');
    const run = (await (await fetch(`${url}/runs/${v.runs[0]!.runId}`)).json()) as { attempts: Array<{ steps: Array<{ kind: string; modelCalls: number; usage?: unknown }> }> };
    expect(run.attempts[0]!.steps.find((st) => st.kind === 'act')).toMatchObject({ modelCalls: 2, usage: { inputTokens: 2000, outputTokens: 60 } });
    expect(logs.join('\n')).not.toContain('sk-ant-test-key');
  });

  it('자격 증명이 없으면 act 는 설정 오류(agent-config)로 blocked — 종료 코드 2, 테스트 실패(1)가 아니다', async () => {
    await createCycle();
    noCredentials();
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
    expect(await runOnce(args(), deps())).toBe(EXIT.blocked);
    expect(logs.join('\n')).toMatch(/blocked: .*ANTHROPIC_API_KEY/);
    expect((await view()).verdict).toBe('blocked');
  });

  it('SINCLAIR_AGENT_* 값이 잘못되면 Run 을 등록하기 전에 설정 오류 3', async () => {
    await createCycle();
    vi.stubEnv('SINCLAIR_AGENT_MODEL_EFFORT', 'turbo');
    expect(await runOnce(args(), deps())).toBe(EXIT.config);
    expect(logs.join('\n')).toMatch(/SINCLAIR_AGENT_MODEL_EFFORT/);
    expect((await view()).runs).toEqual([]);
  });
});
