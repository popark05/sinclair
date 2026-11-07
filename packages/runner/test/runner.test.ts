// runTests: test() API 와 최소 실행기. FakeEngine 으로 결과·스텝·이벤트·아티팩트·재시작을 검증한다.
import { describe, it, expect as vexpect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineError, RUN_EVENT_TYPES, parseRunEvent, type Engine, type RunEvent, type SemanticNode } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN, withDeviceUnavailable } from '@sinclair/protocol/testing';
import { runTests, type Reporter } from '../src/index.ts';

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
