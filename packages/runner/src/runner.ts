// 최소 실행기: 파일을 불러 등록된 테스트를 엔진 하나로 순서대로 돌리고, 스텝·이벤트·아티팩트가 있는 리포트를 낸다.
// 워커당 엔진 1개. 테스트마다 session.open, 실패한 테스트 직후 restart. CLI 는 범위 밖(프로그램 방식 호출).
// test() 레지스트리가 모듈 전역이라 한 프로세스에서 runTests 를 동시에 두 번 돌리면 등록이 섞인다: 반드시 순차로 호출한다.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EngineError, type AttemptFinished, type AttemptResult, type Engine, type RunEvent, type StepRecorded } from '@sinclair/protocol';
import { createScreen, type StepEvent } from './screen.ts';
import { expect as makeExpect, AssertionError } from './expect.ts';
import { drainRegistry, type Fixtures, type TestCase } from './test.ts';

export interface RunOptions {
  engine: Engine;
  /** 실패 시 스냅샷(PNG + 트리 JSON)을 쓰는 디렉터리. 없으면 아티팩트를 남기지 않는다 */
  artifactsDir?: string;
  /** locator 액션 기한(ms, 기본 10초). 판정(expect) 기한은 그 절반: 판정은 화면이 이미 그 상태여야 하므로 액션보다 짧게 잡아 실패를 빨리 드러낸다 */
  timeoutMs?: number;
  /** 식별자(제어 평면의 Run/Cycle 과 맞출 때). 없으면 생성 */
  runId?: string;
  cycleId?: string;
  targetId?: string;
  deviceId?: string;
}

export interface TestResult {
  name: string;
  file: string;
  result: AttemptResult;
  durationMs: number;
  steps: StepRecorded[];
  artifacts: AttemptFinished['artifacts'];
  /** 실패 시 오류 메시지 */
  error?: string;
  /** 실패 시 EngineError 코드 또는 'assertion' */
  errorCode?: string;
  /** 결과에 영향 없는 경고(아티팩트 저장 실패 등) */
  warnings?: string[];
}

export interface RunReport {
  runId: string;
  tests: TestResult[];
  summary: { passed: number; failed: number; blocked: number; skipped: number };
  /** protocol RunEvent 순서대로(run.started → attempt.* → run.finished). Ingest 로 보내는 모양 */
  events: RunEvent[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runTests(files: string[], options: RunOptions): Promise<RunReport> {
  const { engine } = options;
  const runId = options.runId ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const events: RunEvent[] = [];
  const base = () => ({ schema: 1 as const, eventId: randomUUID(), runId, at: new Date().toISOString() });
  events.push({ ...base(), type: 'run.started', cycleId: options.cycleId ?? '', targetId: options.targetId ?? engine.name, deviceId: options.deviceId ?? '' });

  const tests: TestResult[] = [];

  for (const file of files) {
    drainRegistry();
    // ESM 모듈 캐시 때문에 같은 파일을 두 번째 run 에서 다시 평가하지 않으므로, run 마다 다른 질의 문자열로 불러들인다
    await import(`${pathToFileURL(path.resolve(file)).href}?sinclair-run=${runId}`);
    for (const tc of drainRegistry()) {
      tests.push(await runOne(tc, file));
    }
  }

  const summary = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const t of tests) summary[t.result]++;
  // blocked(기기·헬퍼 불가)는 테스트 판정이 아니라 인프라 문제라 Run 은 infra-failed
  events.push({ ...base(), type: 'run.finished', state: summary.blocked > 0 ? 'infra-failed' : 'finished' });
  return { runId, tests, summary, events };

  async function runOne(tc: TestCase, file: string): Promise<TestResult> {
    const attemptId = randomUUID();
    const steps: StepRecorded[] = [];
    const artifacts: AttemptFinished['artifacts'] = [];
    const warnings: string[] = [];
    const started = Date.now();
    events.push({ ...base(), type: 'attempt.started', attemptId, testId: tc.name, attemptNo: 1 });

    const finish = (result: AttemptResult, error?: Error): TestResult => {
      const errorCode = error instanceof EngineError ? error.code : error instanceof AssertionError ? 'assertion' : error ? 'error' : undefined;
      events.push({ ...base(), type: 'attempt.finished', attemptId, result, ...(errorCode ? { errorCode } : {}), artifacts });
      return {
        name: tc.name, file, result, durationMs: Date.now() - started, steps, artifacts,
        ...(error ? { error: error.message } : {}), ...(errorCode ? { errorCode } : {}), ...(warnings.length ? { warnings } : {}),
      };
    };

    if (tc.skip) return finish('skipped');

    const onStep = (step: StepEvent): void => {
      const ev: StepRecorded = {
        ...base(), type: 'step.recorded', attemptId, stepIndex: steps.length, kind: step.kind,
        instruction: step.error ? `${step.instruction} → 실패: ${step.error}` : step.instruction, modelCalls: 0, durationMs: step.durationMs,
      };
      steps.push(ev);
      events.push(ev);
    };
    const screen = createScreen(engine, { timeoutMs, onStep });
    const fixtures: Fixtures = {
      app: {
        open: (target) => session('open', target),
        back: () => session('back'),
        restart: () => session('restart'),
      },
      screen,
      expect: (locator, o) => makeExpect(locator, { timeoutMs: timeoutMs / 2, ...o, onStep }),
    };

    try {
      // 테스트마다 처음 화면에서 시작한다
      await session('open');
      await tc.fn(fixtures);
      return finish('passed');
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const blocked = error instanceof EngineError && error.code === 'device-unavailable';
      await capture(attemptId).catch((err: unknown) => warnings.push(`아티팩트 저장 실패: ${err instanceof Error ? err.message : String(err)}`));
      // 실패한 테스트가 남긴 앱 상태를 바로 버린다(마지막 테스트여도). 기기가 없으면 restart 도 안 되므로 건너뛴다
      if (!blocked) await session('restart').catch((err: unknown) => warnings.push(`restart 실패: ${err instanceof Error ? err.message : String(err)}`));
      return finish(blocked ? 'blocked' : 'failed', error);
    }

    async function session(kind: 'open' | 'back' | 'restart', target?: string): Promise<void> {
      if (!engine.session) throw new EngineError('unsupported-action', `엔진 ${engine.name} 은 session capability 가 없다`);
      if (kind === 'open') await engine.session.open(target);
      else if (kind === 'back') await engine.session.back();
      else await engine.session.restart().catch((err: unknown) => {
        // appId 없는 엔진은 restart 가 unsupported-action: 처음 화면을 다시 여는 것으로 대신한다
        if (err instanceof EngineError && err.code === 'unsupported-action') return engine.session!.open();
        throw err;
      });
    }

    async function capture(id: string): Promise<void> {
      if (!options.artifactsDir) return;
      const obs = await engine.observe({ pixels: true });
      await fs.mkdir(options.artifactsDir, { recursive: true });
      const treeKey = `${id}.screen-tree.json`;
      await fs.writeFile(path.join(options.artifactsDir, treeKey), JSON.stringify({ root: obs.root, atomic: obs.atomic ?? null }, null, 2));
      artifacts.push({ kind: 'screen-tree', key: treeKey });
      if (obs.pixels) {
        const shotKey = `${id}.screenshot.png`;
        await fs.writeFile(path.join(options.artifactsDir, shotKey), obs.pixels);
        artifacts.push({ kind: 'screenshot', key: shotKey });
      }
    }
  }
}
