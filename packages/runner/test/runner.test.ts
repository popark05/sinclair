// runTests: test() API 와 최소 실행기. FakeEngine 으로 결과·스텝·이벤트·아티팩트·재시작을 검증한다.
import { describe, it, expect as vexpect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineError, RUN_EVENT_TYPES, parseRunEvent, type Engine, type RunEvent, type SemanticNode } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN, withDeviceUnavailable } from '@sinclair/protocol/testing';
import { runTests, MAX_RETRIES, type Reporter } from '../src/index.ts';
import { scriptedExecutor, ModelConfigError, type JudgeRequest, type StepExecutor } from '@sinclair/agent';

const SETTINGS_SCREEN: SemanticNode = {
  ref: '@s0', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
    { ref: '@s1', role: 'text', text: '설정', rect: { x: 0, y: 100, width: 1080, height: 80 } },
    { ref: '@s2', role: 'button', name: '설정 검색', rect: { x: 900, y: 100, width: 120, height: 80 } },
  ],
};

function engineWithApps(): FakeEngine {
  return new FakeEngine({
    root: LOGIN_SCREEN,
    onTap: (node) => (node.name === '로그인' ? HOME_SCREEN : undefined),
    screens: { 'com.android.settings': SETTINGS_SCREEN },
  });
}

const fixture = (name: string) => path.resolve(import.meta.dirname, 'fixtures', name);
let artifactsDir: string;
beforeEach(() => { artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-run-')); });
afterEach(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));

describe('runTests', () => {
  it('샘플 테스트가 FakeEngine 에서 통과하고 스텝이 step.recorded 모양으로 남는다', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('sample.sinclair.ts')], { engine, artifactsDir, timeoutMs: 500 });
    vexpect(report.tests.map((t) => [t.name, t.result])).toEqual([['설정 앱 > 열면 "설정" 제목이 보인다', 'passed']]);
    const steps = report.tests[0]!.steps;
    vexpect(steps.map((s) => s.kind)).toEqual(['assert']);
    vexpect(steps[0]).toMatchObject({ type: 'step.recorded', stepIndex: 0, modelCalls: 0, instruction: vexpect.stringContaining('설정') });
    vexpect(steps[0]!.durationMs).toBeGreaterThanOrEqual(0);
    vexpect(engine.performed).toEqual([]); // 판정뿐이라 화면 조작 없음
  });

  it('통과·실패·skip 을 결과로 내고, 실패하면 아티팩트를 남기고 restart 뒤 다음 테스트를 처음 화면에서 돌린다', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('mixed.sinclair.ts')], { engine, artifactsDir, timeoutMs: 200 });
    vexpect(report.tests.map((t) => t.result)).toEqual(['passed', 'failed', 'skipped', 'passed']);
    const failed = report.tests[1]!;
    vexpect(failed.errorCode).toBe('not-found');
    vexpect(failed.error).toContain('없는 문구');
    vexpect(failed.steps.map((s) => s.kind)).toEqual(['locator']);
    const shot = failed.artifacts.find((a) => a.kind === 'screenshot');
    const tree = failed.artifacts.find((a) => a.kind === 'screen-tree');
    vexpect(shot && fs.existsSync(path.join(artifactsDir, shot.key))).toBe(true);
    vexpect(tree && fs.existsSync(path.join(artifactsDir, tree.key))).toBe(true);
    vexpect(report.summary).toEqual({ passed: 2, failed: 1, blocked: 0, skipped: 1 });
    vexpect(report.events.at(-1)).toMatchObject({ type: 'run.finished', state: 'finished' });
  });

  it('이벤트 스트림은 protocol 의 RunEvent 모양이고 run.started → attempt.* → run.finished 순서다', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('mixed.sinclair.ts')], { engine, artifactsDir, timeoutMs: 200 });
    const events: RunEvent[] = report.events;
    for (const e of events) {
      vexpect(RUN_EVENT_TYPES).toContain(e.type);
      vexpect(e).toMatchObject({ schema: 1, eventId: vexpect.any(String), runId: report.runId, at: vexpect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    }
    vexpect(events[0]!.type).toBe('run.started');
    vexpect(events.at(-1)!.type).toBe('run.finished');
    const finished = events.filter((e) => e.type === 'attempt.finished');
    vexpect(finished.map((e) => (e as { result: string }).result)).toEqual(['passed', 'failed', 'skipped', 'passed']);
    vexpect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });

  it('테스트마다 session.open 으로 시작하고 실패한 테스트 직후 restart 한다', async () => {
    const engine = engineWithApps();
    await runTests([fixture('mixed.sinclair.ts')], { engine, artifactsDir, timeoutMs: 200 });
    vexpect(engine.sessionCalls).toEqual(['open', 'open', 'restart', 'open']); // skip 은 세션을 건드리지 않는다
  });

  it('secure 입력값은 스텝 instruction 에 남지 않는다', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('secure.sinclair.ts')], { engine, timeoutMs: 200 });
    vexpect(report.tests[0]!.result).toBe('passed');
    vexpect(engine.performed).toEqual([{ ref: '@e3', action: 'type', arg: 'hunter2' }]);
    const instructions = report.tests[0]!.steps.map((s) => s.instruction);
    vexpect(instructions).toHaveLength(1);
    vexpect(instructions[0]).toContain('type(…)');
    vexpect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('device-unavailable 은 blocked 로 집계하고 Run 은 infra-failed 로 끝난다', async () => {
    const fake = engineWithApps();
    // 기기가 빠진 상황: session.open 이 device-unavailable 을 낸다
    const engine: Engine = withDeviceUnavailable(fake);
    const report = await runTests([fixture('sample.sinclair.ts')], { engine, timeoutMs: 200 });
    vexpect(fake.sessionCalls).toEqual([]); // 기기가 없으면 restart 도 시도하지 않는다
    vexpect(report.tests.map((t) => t.result)).toEqual(['blocked']);
    vexpect(report.summary).toEqual({ passed: 0, failed: 0, blocked: 1, skipped: 0 });
    vexpect(report.events.at(-1)).toMatchObject({ type: 'run.finished', state: 'infra-failed' });
  });

  it('한 프로세스에서 runTests 를 동시에 불러도 등록이 섞이지 않는다(직렬화)', async () => {
    const [a, b] = await Promise.all([
      runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200 }),
      runTests([fixture('mixed.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200 }),
    ]);
    vexpect(a.tests.map((t) => t.name)).toEqual(['설정 앱 > 열면 "설정" 제목이 보인다']);
    vexpect(b.tests).toHaveLength(4);
  });

  it('같은 runId 로 한 프로세스에서 다시 돌려도 테스트가 다시 등록된다(모듈 캐시 키가 runId 가 아니다)', async () => {
    const first = await runTests([fixture('three.sinclair.ts')], { engine: engineWithApps(), runId: 'same-run' });
    const again = await runTests([fixture('three.sinclair.ts')], { engine: engineWithApps(), runId: 'same-run' });
    vexpect([first.tests.length, again.tests.length]).toEqual([3, 3]);
  });

  it('run.started 는 모르는 cycleId/deviceId 를 빈 문자열로 채우지 않는다', async () => {
    const report = await runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200 });
    const started = report.events[0] as Extract<RunEvent, { type: 'run.started' }>;
    vexpect(started.targetId).toBe('fake');
    vexpect('cycleId' in started).toBe(false);
    vexpect('deviceId' in started).toBe(false);
  });
});

describe('Reporter', () => {
  it('이벤트가 발생 순서대로 Reporter 에 도착하고 모두 검증기를 통과하며, run 끝에 flush 가 한 번 불린다', async () => {
    const received: RunEvent[] = [];
    const calls: string[] = [];
    const reporter: Reporter = {
      onEvent: (e) => { received.push(e); calls.push(e.type); },
      flush: async () => { calls.push('flush'); },
    };
    const report = await runTests([fixture('mixed.sinclair.ts')], { engine: engineWithApps(), artifactsDir, timeoutMs: 200, reporter });
    vexpect(received).toEqual(report.events); // 기본 리포트 배열은 그대로
    vexpect(calls.at(-1)).toBe('flush');
    vexpect(calls.filter((c) => c === 'flush')).toHaveLength(1);
    for (const e of received) vexpect(parseRunEvent(e)).toEqual({ ok: true, event: e });
    vexpect(report.warnings).toBeUndefined();
  });

  it('Reporter 가 던지거나 거부해도 테스트 결과는 바뀌지 않고 경고로 남는다', async () => {
    let n = 0;
    const reporter: Reporter = {
      onEvent: async (e) => { n++; if (e.type === 'attempt.started') throw new Error('전송 실패'); },
      flush: async () => { throw new Error('flush 실패'); },
    };
    const report = await runTests([fixture('mixed.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200, reporter });
    vexpect(report.summary).toEqual({ passed: 2, failed: 1, blocked: 0, skipped: 1 });
    vexpect(n).toBe(report.events.length); // 한 번 실패해도 다음 이벤트는 계속 전달
    vexpect(report.warnings?.filter((w) => w.includes('전송 실패'))).toHaveLength(report.events.filter((e) => e.type === 'attempt.started').length);
    vexpect(report.warnings?.some((w) => w.includes('flush 실패'))).toBe(true);
  });

  it('onEvent 가 영영 끝나지 않아도 테스트 진행은 막히지 않는다', async () => {
    const order: string[] = [];
    const reporter: Reporter = { onEvent: (e) => { order.push(e.type); return new Promise(() => {}); } };
    const started = Date.now();
    const report = await runTests([fixture('mixed.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200, reporter, reporterFlushTimeoutMs: 100 });
    vexpect(report.summary).toEqual({ passed: 2, failed: 1, blocked: 0, skipped: 1 });
    vexpect(order.at(-1)).toBe('run.finished'); // 모든 이벤트가 끝까지 전달됐고 그 사이 테스트가 진행됨
    vexpect(Date.now() - started).toBeLessThan(2000);
    vexpect(report.warnings?.some((w) => w.includes('flush'))).toBe(true);
  });

  it('flush 가 기한 안에 끝나지 않으면 경고와 함께 리포트를 돌려준다', async () => {
    const reporter: Reporter = { onEvent: () => {}, flush: () => new Promise(() => {}) };
    const started = Date.now();
    const report = await runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200, reporter, reporterFlushTimeoutMs: 100 });
    vexpect(Date.now() - started).toBeLessThan(2000);
    vexpect(report.tests[0]!.result).toBe('passed');
    vexpect(report.warnings?.some((w) => w.includes('flush'))).toBe(true);
  });

  it('Reporter 가 warnings 를 가지면 flush·close 뒤 리포트 경고에 합쳐진다', async () => {
    const calls: string[] = [];
    const reporter: Reporter = { onEvent: () => {}, flush: async () => { calls.push('flush'); }, close: async () => { calls.push('close'); }, warnings: ['이벤트 e9 거부: kind'] };
    const report = await runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200, reporter });
    vexpect(calls).toEqual(['flush', 'close']);
    vexpect(report.warnings).toEqual(['이벤트 e9 거부: kind']);
  });

  it('flush 가 기한을 넘기면 close 로 Reporter 를 멈추고 그때까지의 경고를 합친다', async () => {
    const warnings: string[] = [];
    let closed = false;
    const reporter: Reporter = { onEvent: () => {}, flush: () => new Promise(() => {}), close: async () => { closed = true; warnings.push('남은 2건 버림'); }, warnings };
    const report = await runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200, reporter, reporterFlushTimeoutMs: 50 });
    vexpect(closed).toBe(true);
    vexpect(report.warnings).toEqual([vexpect.stringContaining('flush'), '남은 2건 버림']);
  });
});

describe('재시도 (retries)', () => {
  it('failed 만 retries 만큼 새 Attempt 로 다시 돌린다: 1차 실패·2차 통과 → passed/attempts 2, 끝내 실패 → failed/attempts retries+1', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('flaky.sinclair.ts')], { engine, artifactsDir, timeoutMs: 200, retries: 2 });
    vexpect(report.tests.map((t) => [t.result, t.attempts])).toEqual([['passed', 2], ['failed', 3], ['passed', 1]]);
    vexpect(report.summary).toEqual({ passed: 2, failed: 1, blocked: 0, skipped: 0 }); // 마지막 시도 기준
    // 이벤트: 같은 testId 로 attemptNo 1,2 / 1,2,3 / 1, 각 attempt 는 started → finished 짝
    const attempts = report.events.filter((e): e is Extract<RunEvent, { type: 'attempt.started' }> => e.type === 'attempt.started');
    vexpect(attempts.map((a) => [a.testId, a.attemptNo])).toEqual([
      ['첫 시도에만 없는 문구를 찾는다', 1], ['첫 시도에만 없는 문구를 찾는다', 2],
      ['끝내 실패한다', 1], ['끝내 실패한다', 2], ['끝내 실패한다', 3],
      ['로그인 버튼이 보인다', 1],
    ]);
    const finished = report.events.filter((e): e is Extract<RunEvent, { type: 'attempt.finished' }> => e.type === 'attempt.finished');
    vexpect(finished.map((f) => f.result)).toEqual(['failed', 'passed', 'failed', 'failed', 'failed', 'passed']);
    vexpect(new Set(finished.map((f) => f.attemptId)).size).toBe(6); // attemptId 는 시도마다 새로
    // 실패한 시도마다 아티팩트가 그 attemptId 로 남는다
    for (const f of finished.filter((x) => x.result === 'failed')) {
      vexpect(f.artifacts.map((a) => a.kind).sort()).toEqual(['screen-tree', 'screenshot']);
      for (const a of f.artifacts) { vexpect(a.key.startsWith(f.attemptId)).toBe(true); vexpect(fs.existsSync(path.join(artifactsDir, a.key))).toBe(true); }
    }
    vexpect(finished.filter((x) => x.result === 'passed').every((f) => f.artifacts.length === 0)).toBe(true);
    // 세션: 테스트마다 open, 실패 뒤 restart, 재시도는 다시 open 으로 시작
    vexpect(engine.sessionCalls).toEqual(['open', 'restart', 'open', 'open', 'restart', 'open', 'restart', 'open', 'restart', 'open']);
    vexpect(report.events.map((e) => e.type).filter((t) => t.startsWith('run.'))).toEqual(['run.started', 'run.finished']);
    for (const e of report.events) vexpect(parseRunEvent(e).ok).toBe(true);
  });

  it('skipped 는 retries 가 있어도 attempt 하나로 끝나고, 앞선 시도의 경고는 재시도가 통과해도 남는다', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('mixed.sinclair.ts')], { engine, timeoutMs: 200, retries: 2 });
    vexpect(report.tests.map((t) => [t.result, t.attempts])).toEqual([['passed', 1], ['failed', 3], ['skipped', 1], ['passed', 1]]);
    vexpect(report.events.filter((e) => e.type === 'attempt.started' && e.testId === '아직 안 만든 기능')).toHaveLength(1);
    // restart 가 깨진 엔진: 첫 시도 실패 뒤 restart 경고가 나고, 재시도가 통과해도 경고는 "시도 1:" 로 남는다
    const flakyRestart = engineWithApps();
    let restarts = 0;
    const origRestart = flakyRestart.session!.restart;
    flakyRestart.session!.restart = async () => { if (restarts++ === 0) throw new Error('restart 불가'); return origRestart(); };
    const r2 = await runTests([fixture('flaky.sinclair.ts')], { engine: flakyRestart, timeoutMs: 200, retries: 1 });
    vexpect(r2.tests[0]).toMatchObject({ result: 'passed', attempts: 2, warnings: [vexpect.stringMatching(/^시도 1: restart 실패: restart 불가/)] });
  });

  it('retries 기본값은 0 이고 blocked 는 재시도하지 않는다', async () => {
    const plain = await runTests([fixture('flaky.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 200 });
    vexpect(plain.tests.map((t) => [t.result, t.attempts])).toEqual([['failed', 1], ['failed', 1], ['passed', 1]]);
    const fake = withDeviceUnavailable(engineWithApps());
    const blocked = await runTests([fixture('flaky.sinclair.ts')], { engine: fake, timeoutMs: 200, retries: 2 });
    vexpect(blocked.tests.map((t) => [t.result, t.attempts])).toEqual([['blocked', 1], ['blocked', 1], ['blocked', 1]]);
    vexpect(blocked.events.filter((e) => e.type === 'attempt.started')).toHaveLength(3);
  });

  it('retries 는 0~5 의 정수여야 한다', async () => {
    vexpect(MAX_RETRIES).toBe(5); // 다른 패키지 상수와 같음은 apps/runner-agent/test/args.test.ts 가 세 값을 함께 읽어 확인한다
    await vexpect(runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), retries: 6 })).rejects.toThrow(/retries/);
    await vexpect(runTests([fixture('sample.sinclair.ts')], { engine: engineWithApps(), retries: 1.5 })).rejects.toThrow(/retries/);
  });
});

describe('취소 (signal)', () => {
  it('두 번째 테스트 도중 abort → 진행 중 테스트는 끝까지, 남은 테스트는 skipped, run 은 cancelled 와 사유', async () => {
    const aborter = new AbortController();
    let opens = 0;
    const engine = new FakeEngine({ root: LOGIN_SCREEN });
    const origOpen = engine.session!.open;
    // 두 번째 테스트가 시작(open)된 직후 abort: 진행 중 테스트는 그대로 통과해야 한다
    engine.session!.open = async (t) => { await origOpen(t); if (++opens === 2) aborter.abort(new Error('lease 를 잃음')); };
    const report = await runTests([fixture('three.sinclair.ts')], { engine, timeoutMs: 200, signal: aborter.signal });
    vexpect(report.tests.map((t) => [t.name, t.result])).toEqual([['첫째', 'passed'], ['둘째', 'passed'], ['셋째', 'skipped']]);
    vexpect(report.cancelled).toEqual({ reason: 'lease 를 잃음' });
    vexpect(report.summary).toEqual({ passed: 2, failed: 0, blocked: 0, skipped: 1 });
    vexpect(report.events.at(-1)).toMatchObject({ type: 'run.finished', state: 'cancelled' });
    const started = report.events.filter((e): e is Extract<RunEvent, { type: 'attempt.started' }> => e.type === 'attempt.started');
    vexpect(started.map((a) => a.testId)).toEqual(['첫째', '둘째', '셋째']); // skipped 도 attempt 로 기록된다
    for (const e of report.events) vexpect(parseRunEvent(e).ok).toBe(true);
  });

  it('abort 되면 진행 중 테스트의 남은 재시도도 시작하지 않는다; 이미 abort 된 신호면 전부 skipped', async () => {
    const aborter = new AbortController();
    const engine = engineWithApps();
    const origOpen = engine.session!.open;
    engine.session!.open = async (t) => { await origOpen(t); aborter.abort('종료 신호'); }; // 첫 테스트 시작 직후 abort
    const report = await runTests([fixture('flaky.sinclair.ts')], { engine, timeoutMs: 200, retries: 2, signal: aborter.signal });
    // 첫 테스트: 1차 실패(첫 시도만 실패하는 샘플) → 취소됐으니 재시도 없음 → failed/attempts 1; 나머지 skipped
    vexpect(report.tests.map((t) => [t.result, t.attempts])).toEqual([['failed', 1], ['skipped', 1], ['skipped', 1]]);
    vexpect(report.cancelled).toEqual({ reason: '종료 신호' });

    const already = await runTests([fixture('three.sinclair.ts')], { engine: engineWithApps(), signal: AbortSignal.abort('미리 중단') });
    vexpect(already.tests.map((t) => t.result)).toEqual(['skipped', 'skipped', 'skipped']);
    vexpect(already).toMatchObject({ cancelled: { reason: '미리 중단' } });
    vexpect(already.events.at(-1)).toMatchObject({ type: 'run.finished', state: 'cancelled' });
  });

  it('마지막 테스트 도중 abort 되어 전부 돌았다면 run 은 finished 이고 cancelled 가 없다; 취소 skipped 에는 errorCode cancelled, 작성자 test.skip 에는 없다', async () => {
    const aborter = new AbortController();
    let opens = 0;
    const engine = engineWithApps();
    const origOpen = engine.session!.open;
    engine.session!.open = async (t) => { await origOpen(t); if (++opens === 3) aborter.abort('늦은 신호'); };
    const done = await runTests([fixture('three.sinclair.ts')], { engine, timeoutMs: 200, signal: aborter.signal });
    vexpect(done.tests.map((t) => t.result)).toEqual(['passed', 'passed', 'passed']);
    vexpect(done.cancelled).toBeUndefined();
    vexpect(done.events.at(-1)).toMatchObject({ state: 'finished' });
    // 첫 테스트 시작 직후 abort: mixed 의 test.skip 은 작성자 skip(errorCode 없음), 나머지는 취소 skip(errorCode cancelled)
    const a2 = new AbortController();
    const e2 = engineWithApps();
    const o2 = e2.session!.open;
    e2.session!.open = async (t) => { await o2(t); a2.abort('lease 를 잃음'); };
    const r2 = await runTests([fixture('mixed.sinclair.ts')], { engine: e2, timeoutMs: 200, signal: a2.signal });
    vexpect(r2.tests.map((t) => [t.result, t.errorCode])).toEqual([['passed', undefined], ['skipped', 'cancelled'], ['skipped', undefined], ['skipped', 'cancelled']]);
  });

  it('blocked 테스트 뒤에 취소되면 infra-failed 보다 cancelled 가 우선한다', async () => {
    const aborter = new AbortController();
    const engine = engineWithApps();
    engine.session!.open = async () => { aborter.abort('종료 신호'); throw new EngineError('device-unavailable', '기기 없음'); };
    const report = await runTests([fixture('three.sinclair.ts')], { engine, timeoutMs: 200, signal: aborter.signal });
    vexpect(report.tests.map((t) => t.result)).toEqual(['blocked', 'skipped', 'skipped']);
    vexpect(report.events.at(-1)).toMatchObject({ type: 'run.finished', state: 'cancelled' });
  });

  it('신호가 abort 되지 않으면 cancelled 가 없다', async () => {
    const report = await runTests([fixture('three.sinclair.ts')], { engine: engineWithApps(), signal: new AbortController().signal });
    vexpect(report.cancelled).toBeUndefined();
    vexpect(report.events.at(-1)).toMatchObject({ state: 'finished' });
  });
});

describe('agent.act (대본 실행기)', () => {
  const loginScript = [
    { name: 'type', input: { ref: '@e2', text: 'qa' } },
    { name: 'tap', input: { ref: '@e4' } },
    { name: 'done', input: { summary: '"환영합니다" 가 보인다' } },
  ];

  it('테스트 파일의 agent.act 가 대본대로 화면을 조작하고 step.recorded(act, modelCalls) 로 남는다', async () => {
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: scriptedExecutor(loginScript) } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed' });
    const act = report.events.find((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.kind === 'act');
    vexpect(act).toMatchObject({ kind: 'act', modelCalls: 3, instruction: vexpect.stringMatching(/^act "아이디 qa 로 로그인해줘" → type @e2, tap @e4, done/) });
    vexpect(act!.instruction).not.toMatch(/"qa"/); // 입력한 글자는 스텝에 남기지 않는다(비밀값일 수 있다 — agent-layer 04)
    for (const e of report.events) vexpect(parseRunEvent(e).ok).toBe(true);
  });

  it('act 가 목표를 이루지 못하면 실패한 Attempt 와 아티팩트가 남고 사유가 오류에 실린다', async () => {
    const stuck = scriptedExecutor(() => ({ name: 'scroll', input: { ref: '@e0', direction: 'down' } }));
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine: engineWithApps(), artifactsDir, timeoutMs: 500, agent: { executor: stuck, maxTurns: 3 } });
    vexpect(report.tests[0]).toMatchObject({ result: 'failed', errorCode: 'agent', error: vexpect.stringMatching(/턴 한도 3/) });
    vexpect(report.tests[0]!.artifacts.map((a) => a.kind).sort()).toEqual(['screen-tree', 'screenshot']);
    const act = report.events.find((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.kind === 'act');
    vexpect(act).toMatchObject({ modelCalls: 3, instruction: vexpect.stringMatching(/실패: 턴 한도 3/) });
  });

  it('기기가 사라져 act 가 던져도 act 스텝은 남고, 엔진 오류 코드가 errorCode 가 된다(agent 가 아니라)', async () => {
    const engine = engineWithApps();
    engine.perform = async () => { throw new EngineError('device-unavailable', '기기 빠짐'); };
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine, timeoutMs: 500, agent: { executor: scriptedExecutor(loginScript) } });
    vexpect(report.tests[0]).toMatchObject({ result: 'blocked', errorCode: 'device-unavailable' });
    vexpect(report.events.filter((e) => e.type === 'step.recorded' && e.kind === 'act')).toEqual([vexpect.objectContaining({ modelCalls: 1 })]); // 던져도 그때까지의 호출 수는 남는다
  });

  it('모델이 보고한 토큰 사용량이 act 스텝(step.recorded usage)에 남는다', async () => {
    const exec = scriptedExecutor(loginScript.map((call) => ({ call, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800 } })));
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: exec } });
    const act = report.events.find((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.kind === 'act');
    vexpect(act).toMatchObject({ modelCalls: 3, usage: { inputTokens: 3000, outputTokens: 150, cacheReadTokens: 2400 } });
    vexpect(parseRunEvent(act).ok).toBe(true);
    const plain = await runTests([fixture('agent-login.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: scriptedExecutor(loginScript) } });
    vexpect(plain.events.find((e) => e.type === 'step.recorded' && e.kind === 'act')).not.toHaveProperty('usage');
  });

  it('실행기 설정 오류(키 없음)와 실행기 없음은 테스트 실패가 아니라 blocked(errorCode agent-config)', async () => {
    const noKey = scriptedExecutor(() => { throw new ModelConfigError('Claude API 자격 증명이 없음: ANTHROPIC_API_KEY 를 설정'); });
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: noKey }, retries: 2 });
    vexpect(report.tests[0]).toMatchObject({ result: 'blocked', errorCode: 'agent-config', attempts: 1, error: vexpect.stringMatching(/ANTHROPIC_API_KEY/) });
    vexpect(report.events.filter((e) => e.type === 'step.recorded' && e.kind === 'act')).toHaveLength(1);
    const none = await runTests([fixture('agent-login.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500 });
    vexpect(none.tests[0]).toMatchObject({ result: 'blocked', errorCode: 'agent-config', error: vexpect.stringMatching(/agent\.executor/) });
  });
});

describe('판정 동사 agent.assert·waitFor·extract (대본 judge)', () => {
  type Judge = (req: JudgeRequest) => unknown;
  const judging = (answer: Judge): StepExecutor => ({ next: () => Promise.reject(new Error('next 금지')), judge: async (req) => ({ answer: answer(req), usage: { inputTokens: 50, outputTokens: 5 } }) });
  /** 화면대로 답하는 정직한 judge. overrides 로 질문별 답을 바꾼다 */
  const honest = (overrides: Record<string, unknown> = {}): Judge => (req) => {
    if (Object.hasOwn(overrides, req.question)) return overrides[req.question];
    const home = /환영합니다/.test(req.observation);
    if (req.kind === 'assert') return { pass: home, reason: home ? '환영 문구가 보인다' : '로그인 화면' };
    if (req.question === '비밀번호') return { found: true, value: 'x', sourceRefs: ['@e3'], reason: '비밀번호 칸' };
    return { found: home, value: '환영합니다', sourceRefs: home ? ['@h1'] : [], reason: '"환영합니다" 문구에서 읽음' }; // 실제 모델처럼 근거에 값을 쓴다
  };
  const stepsOf = (events: RunEvent[], attemptNo = 0) => {
    const attempts = events.filter((e) => e.type === 'attempt.started').map((e) => (e as { attemptId: string }).attemptId);
    return events.filter((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.attemptId === attempts[attemptNo]);
  };

  it('waitFor·assert·extract 가 통과하고 스텝 kind·modelCalls·usage 로 남는다. 판정은 화면을 바꾸지 않는다', async () => {
    const engine = engineWithApps();
    const report = await runTests([fixture('agent-judge.sinclair.ts')], { engine, timeoutMs: 500, agent: { executor: judging(honest()) } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed' });
    const steps = stepsOf(report.events).filter((e) => e.kind !== 'locator');
    vexpect(steps.map((e) => e.kind)).toEqual(['waitFor', 'assert', 'extract']);
    vexpect(steps[1]).toMatchObject({ modelCalls: 1, usage: { inputTokens: 50, outputTokens: 5 }, instruction: vexpect.stringMatching(/^agent\.assert "홈 화면이다" → 참: 환영 문구가 보인다/) });
    vexpect(steps[2]!.instruction).toMatch(/추출함 \(@h1\)/);
    vexpect(JSON.stringify(steps[2])).not.toContain('환영합니다'); // 추출한 값은 근거 문구로도 스텝에 남지 않는다
    vexpect([engine.performed.length, engine.typed.length]).toEqual([1, 0]); // 결정적 탭 하나뿐: 판정은 화면을 바꾸지 않았다
    for (const e of report.events) vexpect(parseRunEvent(e).ok).toBe(true);
  });

  it('거짓 판정은 errorCode assertion 의 failed Attempt 와 아티팩트, 근거가 오류에 실린다', async () => {
    const report = await runTests([fixture('agent-judge.sinclair.ts')], { engine: engineWithApps(), artifactsDir, timeoutMs: 500, agent: { executor: judging(honest({ '홈 화면이다': { pass: false, reason: '설정 화면이 보인다' } })) } });
    vexpect(report.tests[0]).toMatchObject({ result: 'failed', errorCode: 'assertion', error: vexpect.stringMatching(/홈 화면이다.*설정 화면이 보인다/) });
    vexpect(report.tests[0]!.artifacts.map((a) => a.kind).sort()).toEqual(['screen-tree', 'screenshot']);
  });

  it('waitFor 기한 초과·추출 못 찾음은 assertion, 타입 불일치는 agent, secure 추출은 secure-read', async () => {
    const timeout = await runTests([fixture('agent-judge.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: judging(honest({ '환영 문구가 뜬다': { pass: false, reason: '아직' } })) } });
    vexpect(timeout.tests[0]).toMatchObject({ result: 'failed', errorCode: 'assertion', error: vexpect.stringMatching(/2000ms/) });
    const missing = await runTests([fixture('agent-judge.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: judging(honest({ '인사 문구': { found: false, value: '', sourceRefs: [], reason: '없다' } })) } });
    vexpect(missing.tests[0]).toMatchObject({ result: 'failed', errorCode: 'assertion' });
    const wrongType = await runTests([fixture('agent-judge.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: judging(honest({ '인사 문구': { found: true, value: 42, sourceRefs: ['@h1'], reason: 'x' } })) } });
    vexpect(wrongType.tests[0]).toMatchObject({ result: 'failed', errorCode: 'agent' });
    vexpect(timeout.tests[1]).toMatchObject({ result: 'failed', errorCode: 'secure-read' });
    vexpect(stepsOf(timeout.events, 1)).toEqual([vexpect.objectContaining({ kind: 'extract', modelCalls: 1, usage: { inputTokens: 50, outputTokens: 5 } })]); // 거부돼도 스텝·비용은 남는다
  });

  it('judge 없는 실행기면 blocked(agent-config)', async () => {
    const report = await runTests([fixture('agent-judge.sinclair.ts')], { engine: engineWithApps(), timeoutMs: 500, agent: { executor: scriptedExecutor([]) } });
    vexpect(report.tests[0]).toMatchObject({ result: 'blocked', errorCode: 'agent-config' });
  });
});

describe('비밀값 secret()', () => {
  const VALUE = 'Tr0ub4dor&3';
  /** 비밀번호 칸이 secure 가 아니라 입력한 값이 화면 트리에 그대로 보이는 앱 */
  function plainPasswordApp(): FakeEngine {
    const root: SemanticNode = structuredClone(LOGIN_SCREEN);
    root.children![2] = { ref: '@e3', role: 'textbox', placeholder: '비밀번호' };
    const engine = new FakeEngine({ root, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    const perform = engine.perform.bind(engine);
    engine.perform = async (ref, action, arg) => { await perform(ref, action, arg); if (action === 'type' && ref === '@e3') { const r = structuredClone(root); r.children![2]!.value = arg ?? ''; engine.setRoot(r); } };
    return engine;
  }
  const loginScript = [
    { name: 'type', input: { ref: '@e2', text: 'qa' } },
    { name: 'type', input: { ref: '@e3', text: '{{secret:QA_PASSWORD}}' } },
    { name: 'tap', input: { ref: '@e4' } },
    { name: 'done', input: { summary: '로그인함' } },
  ];

  it('엔진에는 실제 값, 모델·이벤트·테스트 오류·screen-tree 아티팩트에는 값이 없다. 없는 비밀값은 blocked(secret-missing)', async () => {
    const engine = plainPasswordApp();
    const exec = scriptedExecutor(loginScript);
    const report = await runTests([fixture('agent-secret.sinclair.ts')], { engine, artifactsDir, timeoutMs: 300, agent: { executor: exec }, secrets: { get: (n) => (n === 'QA_PASSWORD' ? VALUE : undefined) } });
    vexpect(report.tests.map((t) => [t.result, t.errorCode])).toEqual([['passed', undefined], ['failed', 'assertion'], ['blocked', 'secret-missing']]);
    vexpect(engine.performed.filter((p) => p.ref === '@e3').map((p) => p.arg)).toEqual([VALUE, VALUE]); // 에이전트·screen 둘 다 실제 값을 입력했다
    vexpect(report.tests[1]!.error).toMatch(/secret:QA_PASSWORD/); // 화면 요약에 보인 값은 자리표시로
    vexpect(report.tests[2]!.error).toMatch(/NOT_CONFIGURED.*SINCLAIR_SECRET_NOT_CONFIGURED/);
    const tree = fs.readdirSync(artifactsDir).filter((f) => f.endsWith('.screen-tree.json')).map((f) => fs.readFileSync(path.join(artifactsDir, f), 'utf8')).join('');
    vexpect(tree).toContain('secret:QA_PASSWORD');
    for (const text of [JSON.stringify(exec.requests), JSON.stringify(report), tree]) vexpect(text).not.toContain(VALUE);
  });

  it('기본 저장소는 환경변수 SINCLAIR_SECRET_<이름>', async () => {
    process.env.SINCLAIR_SECRET_QA_PASSWORD = VALUE;
    try {
      const engine = plainPasswordApp();
      const report = await runTests([fixture('agent-secret.sinclair.ts')], { engine, timeoutMs: 300, agent: { executor: scriptedExecutor(loginScript) } });
      vexpect(report.tests[0]).toMatchObject({ result: 'passed' });
      vexpect(engine.performed).toContainEqual({ ref: '@e3', action: 'type', arg: VALUE });
    } finally { delete process.env.SINCLAIR_SECRET_QA_PASSWORD; }
  });
});

describe('비밀값 · 리뷰 반영(직렬화·범위)', () => {
  function plainPasswordApp(): FakeEngine {
    const root: SemanticNode = structuredClone(LOGIN_SCREEN);
    root.children![2] = { ref: '@e3', role: 'textbox', placeholder: '비밀번호' };
    const engine = new FakeEngine({ root });
    const perform = engine.perform.bind(engine);
    engine.perform = async (ref, action, arg) => { await perform(ref, action, arg); if (action === 'type' && ref === '@e3') { const r = structuredClone(root); r.children![2]!.value = arg ?? ''; engine.setRoot(r); } };
    return engine;
  }

  it.each(['pa"ss\\w0rd', '1080'])('값 %j: 이벤트·결과·screen-tree 가 올바른 JSON 이고 값(이스케이프 표현 포함)이 없다, 숫자는 그대로', async (value) => {
    const report = await runTests([fixture('agent-secret.sinclair.ts')], { engine: plainPasswordApp(), artifactsDir, timeoutMs: 300, agent: { executor: scriptedExecutor([{ name: 'done', input: { summary: 'x' } }]) }, secrets: { get: (n) => (n === 'QA_PASSWORD' ? value : undefined) } });
    vexpect(report.tests[1]).toMatchObject({ result: 'failed', errorCode: 'assertion' });
    for (const e of report.events) vexpect(parseRunEvent(e).ok).toBe(true);
    const trees = fs.readdirSync(artifactsDir).filter((f) => f.endsWith('.screen-tree.json')).map((f) => fs.readFileSync(path.join(artifactsDir, f), 'utf8'));
    const parsed = trees.map((t) => JSON.parse(t) as { root: SemanticNode });
    vexpect(parsed[0]!.root.rect?.width).toBe(1080); // 숫자 비밀값이 숫자를 바꾸지 않는다
    const all = [JSON.stringify(report), ...trees].join('\n');
    for (const form of [value, JSON.stringify(value).slice(1, -1)]) if (!/^\d+$/.test(value)) vexpect(all).not.toContain(form);
    vexpect(report.tests[1]!.error).toContain('{{secret:QA_PASSWORD}}');
  });

  it('screen.type 은 이 테스트가 secret() 으로 등록한 이름만 치환한다(앞 테스트의 값을 꺼내지 못한다)', async () => {
    const engine = plainPasswordApp();
    const report = await runTests([fixture('agent-secret-scope.sinclair.ts')], { engine, timeoutMs: 300, secrets: { get: () => 'Tr0ub4dor&3' } });
    vexpect(report.tests.map((t) => t.result)).toEqual(['passed', 'failed']);
    vexpect(report.tests[1]!.error).toMatch(/QA_PASSWORD/);
    vexpect(engine.performed.filter((p) => p.ref === '@e2')).toEqual([]);
  });
});

describe('액션 전 안전망이 스텝에 남는다', () => {
  it('다시 찾음은 tap @e4→@x9(다시 찾음), 사라짐은 tap @e4(안전망: 사라짐) 으로 instruction 에 남는다', async () => {
    const engine = engineWithApps();
    const reordered: SemanticNode = { ...LOGIN_SCREEN, children: [{ ...LOGIN_SCREEN.children![3]!, ref: '@x9' }, ...LOGIN_SCREEN.children!.filter((c) => c.ref !== '@e4')] };
    const withoutButton: SemanticNode = { ...LOGIN_SCREEN, children: LOGIN_SCREEN.children!.filter((c) => c.ref !== '@e4') };
    const exec = scriptedExecutor((_req, i) => {
      if (i === 0) { engine.setRoot(withoutButton); return { name: 'tap', input: { ref: '@e4' } }; }
      if (i === 1) { engine.setRoot(LOGIN_SCREEN); return { name: 'type', input: { ref: '@e2', text: 'qa' } }; }
      if (i === 2) { engine.setRoot(reordered); return { name: 'tap', input: { ref: '@e4' } }; }
      return { name: 'done', input: { summary: '환영합니다' } };
    });
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine, timeoutMs: 500, agent: { executor: exec } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed' });
    const act = report.events.find((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.kind === 'act');
    vexpect(act!.instruction).toMatch(/tap @e4\(안전망: 사라짐\), type @e2, tap @e4→@x9\(다시 찾음\), done/);
  });
});

describe('Incident 복구가 스텝에 남는다', () => {
  it('권한 요청을 자동으로 치우면 instruction 에 [Incident: permission→… ×1](정책 deny 가 러너를 지난다)', async () => {
    const pid = (id: string) => `com.android.permissioncontroller:id/${id}`;
    const permission: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@p1', role: 'text', testId: pid('permission_message'), text: '카메라' }, { ref: '@p2', role: 'button', testId: pid('permission_allow_foreground_only_button'), name: '앱 사용 중에만 허용' }, { ref: '@p3', role: 'button', testId: pid('permission_deny_button'), name: '허용 안함' }] };
    const app: SemanticNode = { ...LOGIN_SCREEN, children: LOGIN_SCREEN.children!.map((c) => ({ ...c, testId: c.testId ?? `com.app:id/${c.ref.slice(1)}` })) };
    const engine = new FakeEngine({ root: app, onTap: (n) => (n.name === '로그인' ? permission : n.ref === '@p3' ? HOME_SCREEN : undefined) });
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '환영합니다' } }]);
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine, timeoutMs: 500, agent: { executor: exec, incidents: { permission: 'deny' } } }); // 기본(allow)이 아닌 값으로 옵션이 러너를 지나는지 본다
    vexpect(report.tests[0]).toMatchObject({ result: 'passed' });
    const act = report.events.find((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.kind === 'act');
    vexpect(act!.instruction).toMatch(/\[Incident: permission→허용 안함 ×1\]/);
  });
});
