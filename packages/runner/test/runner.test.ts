// runTests: test() API 와 최소 실행기. FakeEngine 으로 결과·스텝·이벤트·아티팩트·재시작을 검증한다.
import { describe, it, expect as vexpect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineError, RUN_EVENT_TYPES, type Engine, type RunEvent, type SemanticNode } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { runTests } from '../src/index.ts';

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
    const engine: Engine = Object.create(fake, { session: { value: { ...fake.session, open: async () => { throw new EngineError('device-unavailable', '기기 없음'); } } } });
    const report = await runTests([fixture('sample.sinclair.ts')], { engine, timeoutMs: 200 });
    vexpect(fake.sessionCalls).toEqual([]); // 기기가 없으면 restart 도 시도하지 않는다
    vexpect(report.tests.map((t) => t.result)).toEqual(['blocked']);
    vexpect(report.summary).toEqual({ passed: 0, failed: 0, blocked: 1, skipped: 0 });
    vexpect(report.events.at(-1)).toMatchObject({ type: 'run.finished', state: 'infra-failed' });
  });
});
