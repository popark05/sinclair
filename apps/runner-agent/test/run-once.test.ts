// @vitest-environment node
// runOnce: 인프로세스 control-plane + FakeEngine 으로 Run 등록 → 실행 → 보고 → GET /cycles/:id 가 finished. 종료 코드 0/1/2/3.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { FakeEngine, LOGIN_SCREEN, withDeviceUnavailable } from '@sinclair/protocol/testing';
import { startControlPlane, type RunningControlPlane, type CycleView } from '@sinclair/control-plane';
import { runOnce, EXIT, type RunOnceDeps } from '../src/index.ts';

let cp: RunningControlPlane;
let url: string;
const logs: string[] = [];
const deps = (): RunOnceDeps => ({ log: (line) => logs.push(line) });
beforeEach(async () => { cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: '(memory 모드에서는 무시)' }); url = `http://127.0.0.1:${cp.server.port}`; logs.length = 0; });
afterEach(async () => { await cp.close(); });

const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const createCycle = async (cycleId = 'c1') => { await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId, build: 'b', targets: ['android'] }) }); };
const view = async (cycleId = 'c1') => (await (await fetch(`${url}/cycles/${cycleId}`)).json()) as CycleView;

describe('runOnce', () => {
  it('Run 을 발급받아 테스트를 돌리고 보고하면 Cycle 이 finished/verified 이고 종료 코드 0', async () => {
    await createCycle();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake' }, deps());
    expect(code).toBe(EXIT.ok);
    const v = await view();
    expect(v).toMatchObject({ state: 'finished', verdict: 'verified' });
    expect(Object.keys(v.matrix)).toEqual(['로그인 버튼을 누르면 환영 문구가 보인다']);
    expect(logs.join('\n')).toMatch(/run .* 등록/);
    expect(logs.join('\n')).toMatch(/passed 1.*failed 0/);
  });

  it('실패한 테스트가 있으면 1, 테스트 파일은 이름순이고 *.sinclair.ts 만 모은다', async () => {
    await createCycle();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: fixtures, engine: 'fake', timeoutMs: 200 }, deps());
    expect(code).toBe(EXIT.testsFailed);
    const v = await view();
    expect(Object.keys(v.matrix)).toEqual(['없는 문구를 찾다 실패한다', '로그인 버튼을 누르면 환영 문구가 보인다']); // failing.sinclair.ts 가 login 보다 앞
    expect(v.verdict).toBe('blocked');
  });

  it('--run 으로 지정한 Run 을 쓰고, 끝난 Cycle 이나 모르는 Cycle 은 설정 오류 3', async () => {
    await createCycle();
    await fetch(`${url}/cycles/c1/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'r-given' }) });
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-given' }, deps())).toBe(EXIT.ok);
    expect((await view()).runs.map((r) => r.runId)).toEqual(['r-given']);
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: fixtures, engine: 'fake', timeoutMs: 200 }, deps())).toBe(EXIT.config); // 끝난 Cycle: 409
    expect(await runOnce({ controlPlane: url, cycle: '없음', target: 'android', tests: fixtures, engine: 'fake' }, deps())).toBe(EXIT.config);
    expect(logs.join('\n')).toMatch(/409|이미/);
  });

  it('기기 불가(device-unavailable)면 blocked 로 보고하고 2', async () => {
    await createCycle();
    const broken = withDeviceUnavailable(new FakeEngine({ root: LOGIN_SCREEN }));
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', agent: 'node-7' }, { ...deps(), createEngine: async () => ({ engine: broken, dispose: async () => {} }) });
    expect(code).toBe(EXIT.blocked);
    const v = await view();
    expect(v).toMatchObject({ verdict: 'blocked', runs: [{ state: 'infra-failed' }] });
    const runView = (await (await fetch(`${url}/runs/${v.runs[0]!.runId}`)).json()) as { agentId?: string };
    expect(runView.agentId).toBe('node-7');
  });

  it('엔진을 못 만들면(기기 없음) run.started + infra-failed 만 보고하고 2 — Cycle 에 blocked 가 드러난다', async () => {
    await createCycle();
    const code = await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake' }, { ...deps(), createEngine: async () => { throw new Error('꽂힌 Android 기기가 없음'); } });
    expect(code).toBe(EXIT.blocked);
    expect(await view()).toMatchObject({ state: 'finished', verdict: 'blocked', runs: [{ state: 'infra-failed' }] });
    expect(logs.join('\n')).toMatch(/기기 불가.*꽂힌 Android 기기가 없음/);
  });

  it('--run 을 주고 끝난 Cycle 에 실행하면 재사용이 아니라 설정 오류 3 이고 이벤트를 보내지 않는다', async () => {
    await createCycle();
    await fetch(`${url}/cycles/c1/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android', runId: 'r-done' }) });
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-done' }, deps())).toBe(EXIT.ok);
    const before = await (await fetch(`${url}/runs/r-done`)).text();
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, 'only-login'), engine: 'fake', run: 'r-done' }, deps())).toBe(EXIT.config);
    expect(logs.join('\n')).toMatch(/cycle-finished/);
    expect(await (await fetch(`${url}/runs/r-done`)).text()).toBe(before);
  });

  it('테스트 디렉터리가 없거나 비어 있으면 설정 오류 3 이고 Run 을 등록하지 않는다', async () => {
    await createCycle();
    expect(await runOnce({ controlPlane: url, cycle: 'c1', target: 'android', tests: path.join(fixtures, '없음'), engine: 'fake' }, deps())).toBe(EXIT.config);
    expect((await view()).runs).toEqual([]);
  });
});
