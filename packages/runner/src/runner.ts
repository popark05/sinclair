// 최소 실행기: 파일을 불러 등록된 테스트를 엔진 하나로 순서대로 돌리고, 스텝·이벤트·아티팩트가 있는 리포트를 낸다.
// 워커당 엔진 1개. 테스트마다 session.open, 실패한 테스트 직후 restart. CLI 는 범위 밖(프로그램 방식 호출).
// test() 레지스트리가 모듈 전역이라 한 프로세스에서 runTests 를 동시에 두 번 돌리면 등록이 섞인다. 그래서 runTests 는 프로세스 안에서 직렬화된다(아래 chain).
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EngineError, parseRunEvent, type AttemptFinished, type AttemptResult, type Engine, type RunEvent, type StepRecorded } from '@sinclair/protocol';
import { createScreen, type StepEvent } from './screen.ts';
import { expect as makeExpect, AssertionError } from './expect.ts';
import { drainRegistry, type Fixtures, type TestCase } from './test.ts';

/** 러너가 내는 RunEvent 를 발생 즉시 받는 쪽(제어 평면 Ingest 전송 등). 던지거나 느려도 테스트 실행은 멈추지 않는다 */
export interface Reporter {
  onEvent(event: RunEvent): void | Promise<void>;
  /** run 이 끝날 때 한 번. 보류 중인 전송을 마친다 */
  flush?(): Promise<void>;
  /** flush 뒤(기한을 넘겨 버린 뒤에도) 한 번. 재시도·타이머를 멈춘다 */
  close?(): Promise<void>;
  /** Reporter 가 삼키지 않고 알리고 싶은 문제(거부된 이벤트 등). flush 뒤 RunReport.warnings 에 합쳐진다 */
  readonly warnings?: readonly string[];
}

export interface RunOptions {
  engine: Engine;
  /** 이벤트 수신자. 없으면 리포트의 events[] 에만 쌓인다 */
  reporter?: Reporter;
  /** reporter.flush 와 보류 중인 onEvent 를 기다리는 기한(ms, 기본 10초). 넘기면 경고를 남기고 리포트를 돌려준다 */
  reporterFlushTimeoutMs?: number;
  /** 실패 시 스냅샷(PNG + 트리 JSON)을 쓰는 디렉터리. 없으면 아티팩트를 남기지 않는다 */
  artifactsDir?: string;
  /** 취소 신호. abort 되면 진행 중 테스트는 끝까지 가고(러너는 테스트 중간 중단을 지원하지 않는다), 그 테스트의 남은 재시도와 다음 테스트들은 skipped 로 기록되며 run 은 cancelled 로 끝난다 */
  signal?: AbortSignal;
  /** failed 테스트를 다시 돌리는 횟수(기본 0, 최대 5). 시도마다 새 Attempt(attemptNo 2, 3…)로 보고하고 재시도 전에 앱을 다시 띄운다. blocked·skipped 는 재시도하지 않는다 */
  retries?: number;
  /** locator 액션 기한(ms, 기본 10초). 판정(expect) 기한은 그 절반: 판정은 화면이 이미 그 상태여야 하므로 액션보다 짧게 잡아 실패를 빨리 드러낸다 */
  timeoutMs?: number;
  /** 식별자(제어 평면의 Run/Cycle 과 맞출 때). runId 는 없으면 생성, cycleId/deviceId 는 모르면 이벤트에서 생략 */
  runId?: string;
  cycleId?: string;
  targetId?: string;
  deviceId?: string;
  agentId?: string;
}

export interface TestResult {
  name: string;
  file: string;
  /** 마지막 시도의 결과 */
  result: AttemptResult;
  /** 실제로 돈 시도 수(1 이상). 재시도 끝에 통과했는지는 Verdict(passed-flaky)가 attemptNo 로 판단한다 */
  attempts: number;
  /** 마지막 시도의 소요 시간. 앞선 시도는 이벤트(attempt.started/finished 의 at)로 본다 */
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
  /** 결과에 영향 없는 run 수준 경고(Reporter 실패, 검증기에 걸린 이벤트 등) */
  warnings?: string[];
  /** signal 로 중단됐을 때. reason 은 signal.reason 을 문자열로 */
  cancelled?: { reason: string };
}

const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 5;
/** 취소로 시작하지 못한 테스트의 skipped attempt 에 붙는 errorCode. control-plane Verdict 가 이것만 blocked 로 본다(같은 문자열을 따로 둔다) */
export const CANCELLED_CODE = 'cancelled';
/** Reporter 가 원격 전송일 때 마지막 이벤트들의 왕복을 기다릴 여유. 로컬 Reporter 는 즉시 끝난다 */
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/** 한 프로세스 안의 runTests 호출을 순서대로 세운다(레지스트리 공유). 앞 호출이 실패해도 다음은 돈다 */
let chain: Promise<unknown> = Promise.resolve();

export function runTests(files: string[], options: RunOptions): Promise<RunReport> {
  const next = chain.then(() => runTestsExclusive(files, options));
  chain = next.catch(() => undefined);
  return next;
}

async function runTestsExclusive(files: string[], options: RunOptions): Promise<RunReport> {
  const { engine } = options;
  const runId = options.runId ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? 0;
  /** 취소 때문에 시작하지 못한 테스트나 재시도가 있었는지 */
  let cutShort = false;
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) throw new RangeError(`retries 는 0~${MAX_RETRIES} 의 정수여야 함: ${retries}`);
  const events: RunEvent[] = [];
  const warnings: string[] = [];
  const pending: Promise<void>[] = [];
  const base = () => ({ schema: 1 as const, eventId: randomUUID(), runId, at: new Date().toISOString() });
  // 발생 즉시 Reporter 로 넘긴다. Reporter 의 실패·지연이 테스트 실행을 막지 않도록 기다리지 않고 run 끝에 모아서 기다린다
  const emit = (event: RunEvent): void => {
    events.push(event);
    const parsed = parseRunEvent(event);
    if (!parsed.ok) warnings.push(`이벤트 ${event.type} 검증 실패: ${parsed.errors.join(', ')}`);
    if (!options.reporter) return;
    const failed = (err: unknown) => { warnings.push(`Reporter onEvent(${event.type}) 실패: ${errorMessage(err)}`); };
    try {
      const r = options.reporter.onEvent(event);
      if (r) pending.push(r.catch(failed));
    } catch (err) {
      failed(err);
    }
  };
  emit({
    ...base(), type: 'run.started', targetId: options.targetId ?? engine.name,
    ...(options.cycleId ? { cycleId: options.cycleId } : {}), ...(options.deviceId ? { deviceId: options.deviceId } : {}), ...(options.agentId ? { agentId: options.agentId } : {}),
  });

  const tests: TestResult[] = [];

  for (const file of files) {
    drainRegistry();
    // ESM 모듈 캐시 때문에 같은 파일을 두 번째 run 에서 다시 평가하지 않으므로, 불러들일 때마다 다른 질의 문자열을 쓴다.
    // runId 는 키가 될 수 없다: 같은 runId 로 다시 돌리면(재보고·테스트) 캐시된 모듈이 돌아와 테스트가 하나도 등록되지 않는다
    await import(`${pathToFileURL(path.resolve(file)).href}?sinclair-load=${randomUUID()}`);
    for (const tc of drainRegistry()) {
      tests.push(await runOne(tc, file));
    }
  }

  const summary = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const t of tests) summary[t.result]++;
  // 실제로 무언가를 못 돌렸을 때만 cancelled: 마지막 테스트 도중 신호가 와서 전부 끝까지 돌았다면 완료된 run 이다(Cycle 을 blocked 로 만들지 않는다)
  const cancelled = cutShort && options.signal ? { reason: abortReason(options.signal) } : undefined;
  // blocked(기기·헬퍼 불가)는 테스트 판정이 아니라 인프라 문제라 Run 은 infra-failed. 취소는 그보다 우선한다: 돌지 않은 케이스가 있다는 뜻이 같고, 사유가 더 구체적이다
  emit({ ...base(), type: 'run.finished', state: cancelled ? 'cancelled' : summary.blocked > 0 ? 'infra-failed' : 'finished' });
  await flushReporter();
  // flush 기한을 넘긴 Reporter 가 나중에 경고를 더해도 리포트는 바뀌지 않도록 복사한다
  return { runId, tests, summary, events, ...(warnings.length ? { warnings: [...warnings] } : {}), ...(cancelled ? { cancelled } : {}) };

  async function flushReporter(): Promise<void> {
    if (!options.reporter) return;
    const limit = options.reporterFlushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), limit); });
    const work = (async () => {
      await Promise.all(pending);
      await options.reporter!.flush?.();
    })().then(() => 'done' as const, (err: unknown) => { warnings.push(`Reporter flush 실패: ${errorMessage(err)}`); return 'done' as const; });
    const outcome = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') warnings.push(`Reporter flush 가 ${limit}ms 안에 끝나지 않아 기다리지 않음`);
    // close 가 기한을 넘긴 flush 를 멈추지 못할 수도 있으니 같은 기한으로 한 번 더 경주한다
    const closing = options.reporter.close?.().catch((err: unknown) => { warnings.push(`Reporter close 실패: ${errorMessage(err)}`); });
    if (closing) await Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, limit).unref?.())]);
    warnings.push(...(options.reporter.warnings ?? []));
  }

  async function runOne(tc: TestCase, file: string): Promise<TestResult> {
    // 취소된 뒤에는 시작하지 않는다: skipped(errorCode cancelled) attempt 하나로 기록해, 작성자가 건너뛴 test.skip 과 Verdict 가 구분할 수 있게 한다
    if (options.signal?.aborted && !tc.skip) { cutShort = true; return runAttempt(tc, file, 1, true); }
    let last = await runAttempt(tc, file, 1);
    // failed 만 다시 돈다: blocked 는 기기 문제라 반복해도 같고, skipped 는 attempt 하나(attemptNo 1)로 보고하고 끝난다
    const earlierWarnings: string[] = [];
    for (let no = 2; last.result === 'failed' && no <= retries + 1; no++) {
      // 취소되면 남은 재시도를 시작하지 않는다. 결과는 마지막 시도의 failed 그대로 두고, 못 돈 재시도가 있으니 run 은 cancelled
      if (options.signal?.aborted) { cutShort = true; break; }
      // 앞선 시도의 경고(아티팩트·restart 실패)는 재시도가 통과해도 버리지 않는다
      earlierWarnings.push(...(last.warnings ?? []).map((w) => `시도 ${last.attempts}: ${w}`));
      last = await runAttempt(tc, file, no);
    }
    const warnings = [...earlierWarnings, ...(last.warnings ?? [])];
    return warnings.length ? { ...last, warnings } : last;
  }

  async function runAttempt(tc: TestCase, file: string, attemptNo: number, cancelledSkip = false): Promise<TestResult> {
    const attemptId = randomUUID();
    const steps: StepRecorded[] = [];
    const artifacts: AttemptFinished['artifacts'] = [];
    const attemptWarnings: string[] = [];
    const started = Date.now();
    emit({ ...base(), type: 'attempt.started', attemptId, testId: tc.name, attemptNo });

    const finish = (result: AttemptResult, error?: Error): TestResult => {
      const errorCode = cancelledSkip ? CANCELLED_CODE : error instanceof EngineError ? error.code : error instanceof AssertionError ? 'assertion' : error ? 'error' : undefined;
      emit({ ...base(), type: 'attempt.finished', attemptId, result, ...(errorCode ? { errorCode } : {}), artifacts });
      return {
        name: tc.name, file, result, attempts: attemptNo, durationMs: Date.now() - started, steps, artifacts,
        ...(error ? { error: error.message } : {}), ...(errorCode ? { errorCode } : {}), ...(attemptWarnings.length ? { warnings: attemptWarnings } : {}),
      };
    };

    if (tc.skip || cancelledSkip) return finish('skipped');

    const onStep = (step: StepEvent): void => {
      const ev: StepRecorded = {
        ...base(), type: 'step.recorded', attemptId, stepIndex: steps.length, kind: step.kind,
        instruction: step.error ? `${step.instruction} → 실패: ${step.error}` : step.instruction, modelCalls: 0, durationMs: step.durationMs,
      };
      steps.push(ev);
      emit(ev);
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
      attemptNo,
    };

    try {
      // 시도마다 처음 화면에서 시작한다(실패 직후 restart 로 앱 상태는 이미 버렸다)
      await session('open');
      await tc.fn(fixtures);
      return finish('passed');
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const blocked = error instanceof EngineError && error.code === 'device-unavailable';
      await capture(attemptId).catch((err: unknown) => attemptWarnings.push(`아티팩트 저장 실패: ${errorMessage(err)}`));
      // 실패한 시도가 남긴 앱 상태를 바로 버린다(재시도·다음 테스트·마지막 테스트 모두). 기기가 없으면 restart 도 안 되므로 건너뛴다
      if (!blocked) await session('restart').catch((err: unknown) => attemptWarnings.push(`restart 실패: ${errorMessage(err)}`));
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

function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return r instanceof Error ? r.message : typeof r === 'string' ? r : String(r ?? '중단');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
