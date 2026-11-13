// 최소 실행기: 파일을 불러 등록된 테스트를 엔진 하나로 순서대로 돌리고, 스텝·이벤트·아티팩트가 있는 리포트를 낸다.
// 워커당 엔진 1개. 테스트마다 session.open, 실패한 테스트 직후 restart. CLI 는 범위 밖(프로그램 방식 호출).
// test() 레지스트리가 모듈 전역이라 한 프로세스에서 runTests 를 동시에 두 번 돌리면 등록이 섞인다. 그래서 runTests 는 프로세스 안에서 직렬화된다(아래 chain).
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAct, actProgressOf, replayRecording, appPackageOf, judgeAssert, judgeWaitFor, judgeExtract, ModelConfigError, SecretBox, SECRET_NAME, secretPlaceholder, DEFAULT_PII, type JudgeResult, type PiiFilter, type StepExecutor } from '@sinclair/agent';
import { EngineError, parseRunEvent, CACHE_SCHEMA, CACHE_LIMITS, type AttemptFinished, type AttemptResult, type CacheEntry, type CacheStore, type Engine, type RunEvent, type SemanticNode, type StepRecorded } from '@sinclair/protocol';
import { cacheKey, normalizeInstruction, type CacheMode } from './recording-cache.ts';
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

/** 비밀값 저장소. 기본은 환경변수 SINCLAIR_SECRET_<이름>(envSecretStore). 사내 비밀 저장소는 이 모양의 어댑터로 */
export interface SecretStore { get(name: string): string | undefined }
export const SECRET_ENV_PREFIX = 'SINCLAIR_SECRET_';
/** 접두사를 붙여 읽는다: secret('PATH') 가 아무 환경변수나 읽게 두지 않는다 */
export const envSecretStore = (env: Record<string, string | undefined> = process.env): SecretStore => ({ get: (name) => env[`${SECRET_ENV_PREFIX}${name}`] });

export interface RunOptions {
  engine: Engine;
  /** secret(이름) 의 값을 찾는 곳(기본 envSecretStore()) */
  secrets?: SecretStore;
  /** 화면 개인정보 가림(기본 켜짐: 이메일·전화번호 등 패턴). 모델 요청과 러너의 기록(이벤트·테스트 오류·screen-tree) 모두. false 면 끔 */
  pii?: PiiFilter | false;
  /** 이벤트 수신자. 없으면 리포트의 events[] 에만 쌓인다 */
  reporter?: Reporter;
  /** reporter.flush 와 보류 중인 onEvent 를 기다리는 기한(ms, 기본 10초). 넘기면 경고를 남기고 리포트를 돌려준다 */
  reporterFlushTimeoutMs?: number;
  /** 실패 시 스냅샷(PNG + 트리 JSON)을 쓰는 디렉터리. 없으면 아티팩트를 남기지 않는다 */
  artifactsDir?: string;
  /** 취소 신호. abort 되면 진행 중 테스트는 끝까지 가고(러너는 테스트 중간 중단을 지원하지 않는다), 그 테스트의 남은 재시도와 다음 테스트들은 skipped 로 기록되며 run 은 cancelled 로 끝난다 */
  signal?: AbortSignal;
  /** agent.act 의 실행기(모델)와 한도. 없으면 agent.act 는 설정 오류로 실패한다 */
  agent?: { executor: StepExecutor; maxTurns?: number; timeoutMs?: number; safetyNet?: { pixels?: boolean }; incidents?: { permission?: 'allow' | 'deny' }; pii?: PiiFilter | false };
  /** 녹화 캐시(recording-cache): agent.act 가 한 액션을 기록해 두고 다음 실행에 재생한다. 없거나 mode off 면 끔. 기본 mode read-write */
  cache?: { store: CacheStore; mode?: CacheMode; /** 재생: 대상이 없을 때 기다리는 상한(기본 3초) */ findTimeoutMs?: number; /** 재생: 끝 anchor 를 기다리는 상한(기본 5초) */ endTimeoutMs?: number };
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
  /** 녹화 캐시 기록(쓰기 모드일 때만): 커밋한 act 수, 뒤에 검증이 없어 버린 act 수, 실패와 함께라 지운 녹화 수 */
  cache?: { saved: number; unconfirmed: number; evicted: number };
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

/** 모델 실행기 설정 오류(키 없음·잘못된 키·실행기 없음)의 errorCode. 결과는 blocked */
export const AGENT_CONFIG_CODE = 'agent-config';

/** secret(이름) 의 값이 저장소에 없거나 이름이 잘못됨. 테스트 탓이 아니라 실행 환경 설정이라 blocked */
export class SecretMissingError extends Error {
  override name = 'SecretMissingError';
}
export const SECRET_MISSING_CODE = 'secret-missing';

/** agent.act 가 목표를 이루지 못함(턴·시간 한도, 모델 오류). errorCode 'agent' 로 판정 실패와 구분된다 */
/** strict 녹화 캐시가 재생할 수 없음: 녹화 없음(cache-miss) 또는 녹화와 어긋남(cache-stale). 테스트가 녹화와 맞지 않는다는 판정이라 failed 다(blocked 아님) */
export class CacheReplayError extends Error {
  override name = 'CacheReplayError';
  constructor(readonly code: 'cache-miss' | 'cache-stale', message: string) { super(message); }
}

export class AgentActError extends Error {}
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
  // 이 run 에서 secret() 으로 쓴 값들. 러너의 모든 출구(이벤트·테스트 오류·경고·screen-tree)에서 값 일치로 자리표시로 가린다 — 앞 테스트가 입력한 값이 뒤 테스트 화면에 남아도
  const secretBox = new SecretBox();
  const secretStore = options.secrets ?? envSecretStore();
  const piiOption = options.pii ?? options.agent?.pii;
  const pii = piiOption === false ? undefined : piiOption ?? DEFAULT_PII;
  const hide = (t: string): string => { const a = secretBox.size ? secretBox.redact(t) : t; return pii ? pii.redact(a) : a; };
  // 문자열 잎만 가린다: 직렬화한 글을 가리면 숫자처럼 보이는 값(PIN)이 키·숫자를 바꿔 JSON 을 깬다
  const hideDeep = <T>(v: T): T => { const a = secretBox.redactDeep(v); return pii ? pii.redactDeep(a) : a; };
  // 화면 이미지는 가릴 수 없다: 이미지를 모델에 보내는 실행기면 한 번 알린다
  if (pii && options.agent?.executor.pixels) warnings.push('화면 이미지를 모델에 보내는 실행기라 개인정보 가림이 이미지에는 적용되지 않는다(SINCLAIR_AGENT_MODEL_PIXELS)');
  // 발생 즉시 Reporter 로 넘긴다. Reporter 의 실패·지연이 테스트 실행을 막지 않도록 기다리지 않고 run 끝에 모아서 기다린다
  // 식별 필드는 가리지 않는다: testId(테스트 이름)의 번호가 가려지면 서로 다른 테스트가 control-plane 에서 하나로 합쳐진다
  const IDENTITY = ['eventId', 'runId', 'attemptId', 'testId', 'cycleId', 'targetId', 'deviceId', 'agentId'] as const;
  const hideEvent = <E extends RunEvent>(ev: E): E => {
    const out = hideDeep(ev) as Record<string, unknown>;
    for (const k of IDENTITY) if (k in ev) out[k] = (ev as unknown as Record<string, unknown>)[k];
    return out as E;
  };
  const emit = (raw: RunEvent): void => {
    const event = hideEvent(raw);
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
  return { runId, tests, summary, events, ...(warnings.length ? { warnings: warnings.map(hide) } : {}), ...(cancelled ? { cancelled } : {}) };

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
    // failed 만 다시 돈다: blocked 는 기기 문제라 반복해도 같고, skipped 는 attempt 하나(attemptNo 1)로 보고하고 끝난다.
    // strict 녹화 캐시 실패(cache-miss·cache-stale)도 다시 돌지 않는다: 녹화와 테스트가 맞지 않는다는 결정적 판정이다
    const earlierWarnings: string[] = [];
    for (let no = 2; last.result === 'failed' && last.errorCode !== 'cache-miss' && last.errorCode !== 'cache-stale' && no <= retries + 1; no++) {
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

    const finish = (result: AttemptResult, error?: Error, cache?: TestResult['cache']): TestResult => {
      const errorCode = cancelledSkip ? CANCELLED_CODE : error instanceof EngineError ? error.code : error instanceof AssertionError ? 'assertion' : error instanceof CacheReplayError ? error.code : error instanceof AgentActError ? 'agent' : error instanceof ModelConfigError ? AGENT_CONFIG_CODE : error instanceof SecretMissingError ? SECRET_MISSING_CODE : error ? 'error' : undefined;
      emit({ ...base(), type: 'attempt.finished', attemptId, result, ...(errorCode ? { errorCode } : {}), artifacts });
      return {
        name: tc.name, file, result, attempts: attemptNo, durationMs: Date.now() - started, steps, artifacts,
        ...(error ? { error: hide(error.message) } : {}), ...(errorCode ? { errorCode } : {}), ...(attemptWarnings.length ? { warnings: attemptWarnings.map(hide) } : {}), ...(cache ? { cache } : {}),
      };
    };

    if (tc.skip || cancelledSkip) return finish('skipped');

    // 녹화 캐시: act 녹화를 스테이징했다가, 그 뒤 검증 스텝(expect 통과·assert 참·waitFor 충족)이 있으면 Attempt 끝에 커밋한다
    const cacheMode: CacheMode = options.cache ? options.cache.mode ?? 'read-write' : 'off';
    const cacheOn = cacheMode !== 'off';
    const staged: Array<{ stepIndex: number; key: string; entry: CacheEntry }> = [];
    /** 이 시도가 재생에 쓴 녹화(완전히 재생했거나 이어받음): 시도가 실패했는데 뒤 검증으로 확인되지 않았으면 지운다 */
    const consumed: Array<{ stepIndex: number; key: string }> = [];
    let lastVerified = -1;
    const callIndexes = new Map<string, number>();
    const onStep = (step: StepEvent): void => {
      // 결과(TestResult.steps)와 이벤트가 같은 가린 객체를 쓴다
      const ev: StepRecorded = hideEvent({
        ...base(), type: 'step.recorded' as const, attemptId, stepIndex: steps.length, kind: step.kind,
        instruction: step.error ? `${step.instruction} → 실패: ${step.error}` : step.instruction, modelCalls: step.modelCalls ?? 0, durationMs: step.durationMs,
        ...(step.usage ? { usage: step.usage } : {}), ...(cacheOn && step.cache ? { cache: step.cache } : {}),
      });
      if ((step.kind === 'assert' || step.kind === 'waitFor') && !step.error) lastVerified = steps.length;
      steps.push(ev);
      emit(ev);
    };
    /** Attempt 끝: 검증된 녹화만 쓰고 나머지는 버린다. 실패한 시도가 재생에 쓴 확인되지 않은 녹화는 지운다(모델·비밀값·기기 같은 인프라 실패는 녹화 탓이 아니라 지우지 않는다). 저장소 실패는 결과를 바꾸지 않는다(경고) */
    const settleCache = async (error?: Error): Promise<TestResult['cache']> => {
      if (cacheMode !== 'read-write') return undefined;
      let saved = 0, evicted = 0;
      const savedKeys = new Set<string>();
      for (const s of staged) {
        if (s.stepIndex >= lastVerified) continue;
        try { await options.cache!.store.write(s.key, s.entry); saved++; savedKeys.add(s.key); } catch (err) { attemptWarnings.push(`녹화 캐시 저장 실패: ${errorMessage(err)}`); }
      }
      const infra = error instanceof ModelConfigError || error instanceof SecretMissingError || (error instanceof EngineError && (error.code === 'device-unavailable' || error.code === 'engine-closed'));
      if (error && !infra) {
        for (const c of consumed) {
          if (c.stepIndex < lastVerified || savedKeys.has(c.key)) continue;
          try { await options.cache!.store.delete(c.key); evicted++; savedKeys.add(c.key); } catch (err) { attemptWarnings.push(`녹화 캐시 지우기 실패: ${errorMessage(err)}`); }
        }
      }
      return { saved, unconfirmed: staged.filter((s) => s.stepIndex >= lastVerified).length, evicted };
    };
    /** screen 의 type 에 온 자리표시를 실제 값으로(에이전트와 같은 규칙: 등록된 이름만) */
    // 이 시도가 secret() 으로 등록한 이름만 치환한다(앞 테스트가 등록한 값을 자리표시만으로 꺼내지 못하게)
    const attemptSecrets = new Set<string>();
    const reveal = (text: string): string => {
      if (!text.includes('{{secret:')) return text;
      const r = secretBox.reveal(text, attemptSecrets);
      // 테스트 코드의 실수(secret() 을 부르지 않고 자리표시를 씀)라 설정 문제(blocked)가 아니라 실패다
      if (!r.ok) throw new Error(`screen.type: ${r.error.replace('목표에 주어진 자리표시만', "이 테스트에서 secret() 으로 받은 자리표시만")}`);
      return r.text;
    };
    const screen = createScreen(engine, { timeoutMs, onStep, reveal });
    /** 판정 동사 하나 = 스텝 하나. 거짓·기한 초과·못 찾음은 판정 실패(assertion), 모델이 계약을 어긴 답은 agent, secure 는 엔진 오류(secure-read) 그대로.
     *  스텝에는 질문과 판정·근거만 남기고 추출한 값은 남기지 않는다(화면의 개인정보일 수 있다) */
    async function judgeStep<V>(kind: 'assert' | 'waitFor' | 'extract', verb: string, question: string, run: (executor: StepExecutor) => Promise<JudgeResult<V>>): Promise<JudgeResult<V>> {
      if (!options.agent) throw new ModelConfigError(`${verb} 를 쓰려면 runTests 에 agent.executor(모델 실행기)가 필요함`);
      const started = Date.now();
      const head = `${verb} ${JSON.stringify(question)}`;
      const short = (t: string) => (t.length > 200 ? `${t.slice(0, 200)}…` : t);
      let r: JudgeResult<V>;
      try {
        r = await run(options.agent.executor);
      } catch (err) {
        const p = actProgressOf(err); // secure 거부 등으로 던져도 그때까지의 모델 비용은 남긴다
        onStep({ kind, instruction: head, durationMs: Date.now() - started, ...(p ? { modelCalls: p.modelCalls, ...(p.usage ? { usage: p.usage } : {}) } : {}), error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      const stats = { modelCalls: r.modelCalls, ...(r.usage ? { usage: r.usage } : {}) };
      if (r.ok) {
        // extract 는 근거 문구에도 값이 들어가므로(모델이 "합계 12,300원 에서 읽음" 처럼 쓴다) 근거 노드 ref 만 남긴다
        const done = kind === 'extract' ? `추출함 (${(r.sourceRefs ?? []).filter((x) => /^@[\w:.-]{1,40}$/.test(x)).slice(0, 5).join(', ')})` : `참: ${short(r.reason)}`;
        onStep({ kind, instruction: `${head} → ${done}`, durationMs: Date.now() - started, ...stats });
        return r;
      }
      onStep({ kind, instruction: head, durationMs: Date.now() - started, ...stats, error: `${r.failure}: ${short(r.reason)}` });
      if (r.failure === 'invalid') throw new AgentActError(`${head} 실패: ${r.reason}`);
      throw new AssertionError(verb, question, r.failure, `${head} ${r.failure === 'false' ? '거짓' : r.failure === 'timeout' ? '기한 초과' : '찾지 못함'}: ${r.reason}`);
    }
    const fixtures: Fixtures = {
      app: {
        open: (target) => session('open', target),
        back: () => session('back'),
        restart: () => session('restart'),
      },
      screen,
      expect: (locator, o) => makeExpect(locator, { timeoutMs: timeoutMs / 2, ...o, onStep }),
      agent: {
        async act(goal) {
          if (!options.agent) throw new ModelConfigError('agent.act 를 쓰려면 runTests 에 agent.executor(모델 실행기)가 필요함');
          const started = Date.now();
          const norm = normalizeInstruction(goal);
          const callIndex = callIndexes.get(norm) ?? 0;
          callIndexes.set(norm, callIndex + 1);
          // 녹화 캐시: 키는 act 시작 화면의 앱으로. 첫 시도만 재생한다(재시도는 녹화를 의심할 이유가 있다 — 라이브로 돌고 기록만)
          let key: string | undefined;
          let handOff: string | undefined;
          let prefix: { entry: CacheEntry; done: string[]; total: number; reason: string; startRoot?: SemanticNode } | undefined;
          const brief = (t: string) => (t.length > 200 ? `${t.slice(0, 200)}…` : t);
          if (cacheOn) {
            key = cacheKey({ testId: tc.name, engine: engine.name, app: appPackageOf((await engine.observe()).root) ?? '', instruction: goal, callIndex });
            let entry: CacheEntry | undefined;
            // strict 는 모든 시도에서 재생한다(녹화와 맞는지가 곧 판정)
            if (attemptNo === 1 || cacheMode === 'strict') {
              try { entry = await options.cache!.store.read(key); } catch (err) { attemptWarnings.push(`녹화 캐시 읽기 실패(미스로 봄): ${errorMessage(err)}`); }
            }
            if (!entry && cacheMode === 'strict') {
              const msg = `act ${JSON.stringify(goal)}: strict 녹화 캐시에 녹화가 없음`;
              onStep({ kind: 'act', instruction: `act ${JSON.stringify(goal)}`, durationMs: Date.now() - started, error: '녹화 없음(strict)' });
              throw new CacheReplayError('cache-miss', msg);
            }
            if (entry) {
              const rp = await replayRecording(engine, entry, { goal, secrets: secretBox, ...(options.cache!.findTimeoutMs !== undefined ? { findTimeoutMs: options.cache!.findTimeoutMs } : {}), ...(options.cache!.endTimeoutMs !== undefined ? { endTimeoutMs: options.cache!.endTimeoutMs } : {}) });
              if (rp.outcome === 'replayed') {
                onStep({ kind: 'act', instruction: `act ${JSON.stringify(goal)} → 재생 ${rp.executed}/${rp.total}`, durationMs: Date.now() - started, modelCalls: 0, cache: 'replayed' });
                consumed.push({ stepIndex: steps.length - 1, key });
                return;
              }
              if (cacheMode === 'strict') {
                const why = `재생 ${rp.executed}/${rp.total} 에서 어긋남(${brief(rp.reason)})`;
                onStep({ kind: 'act', instruction: `act ${JSON.stringify(goal)}`, durationMs: Date.now() - started, error: `${why} — strict 라 이어받지 않음` });
                throw new CacheReplayError('cache-stale', `act ${JSON.stringify(goal)}: ${why}`);
              }
              if (rp.outcome === 'diverged') {
                handOff = `재생 ${rp.executed}/${rp.total} 뒤 이어받음(${brief(rp.reason)})`;
                prefix = { entry, done: rp.done, total: rp.total, reason: rp.reason, ...(rp.startRoot ? { startRoot: rp.startRoot } : {}) };
              }
              else attemptWarnings.push(`녹화 캐시 재생 안 함: ${brief(rp.reason)}`);
            }
          }
          let r;
          try {
            r = await runAct(engine, goal, { executor: options.agent.executor, secrets: secretBox, pii: pii ?? false, ...(prefix ? { replayedPrefix: { done: prefix.done, total: prefix.total, reason: prefix.reason }, ...(prefix.startRoot ? { anchorsFrom: prefix.startRoot } : {}) } : {}), ...(options.agent.safetyNet ? { safetyNet: options.agent.safetyNet } : {}), ...(options.agent.incidents ? { incidents: options.agent.incidents } : {}), ...(options.agent.maxTurns !== undefined ? { maxTurns: options.agent.maxTurns } : {}), ...(options.agent.timeoutMs !== undefined ? { timeoutMs: options.agent.timeoutMs } : {}) });
          } catch (err) {
            // 관찰 실패·인프라 오류(기기 없음 등)로 루프가 던져도 act 스텝은 남긴다(act 하나 = 스텝 하나). 오류는 그대로 올려 엔진 코드가 errorCode 가 된다
            const p = actProgressOf(err); // 던지기 전까지 쓴 모델 호출·토큰도 비용으로 남긴다
            onStep({ kind: 'act', instruction: `act ${JSON.stringify(goal)}`, durationMs: Date.now() - started, ...(p ? { modelCalls: p.modelCalls, ...(p.usage ? { usage: p.usage } : {}) } : {}), error: err instanceof Error ? err.message : String(err), cache: 'live' });
            throw err;
          }
          // 툴 요약: 이름과 대상 ref 만(입력한 글자는 남기지 않는다 — 비밀값일 수 있다). ref 는 모델이 쓴 값이라 ref 모양일 때만 싣는다
          const refOf = (input: unknown): string => { const v = (input as { ref?: unknown } | null)?.ref; return typeof v === 'string' && /^@[\w:.-]{1,40}$/.test(v) ? ` ${v}` : ''; };
          // 안전망 개입도 남긴다: 다시 찾은 대상(→ 새 ref), 실행하지 않은 이유(사라짐·애매함·덮임)
          const GUARD = { gone: '사라짐', ambiguous: '애매함', covered: '덮임' } as const;
          const safeRef = (ref?: string) => (ref && /^@[\w:.-]{1,40}$/.test(ref) ? ref : '');
          const tools = r.history.map((h) => {
            const head = h.call ? `${h.call.name}${refOf(h.call.input)}` : '(툴 없음)';
            if (h.guard) return `${head}(안전망: ${GUARD[h.guard]})`;
            if (h.retargeted) return `${head}→${safeRef(h.retargeted) || '?'}(다시 찾음)`;
            return `${head}${h.result === 'ok' ? '' : `(${h.result})`}`;
          }).join(', ');
          // 자동 복구한 Incident: 종류→복구 동작 ×횟수(버튼 문구는 시스템 창의 것이라 비밀값이 아니지만 길이를 묶는다)
          const incidents = r.incidents?.length ? ` [Incident: ${r.incidents.map((i) => `${i.kind}→${i.action.slice(0, 40)} ×${i.count}`).join(', ')}]` : '';
          const instruction = `act ${JSON.stringify(goal)} → ${handOff ? `${handOff} → ` : ''}${tools || '(툴 없음)'} (${r.turns}턴)${incidents}`;
          onStep({ kind: 'act', instruction, durationMs: Date.now() - started, modelCalls: r.modelCalls, ...(r.usage ? { usage: r.usage } : {}), ...(r.ok ? {} : { error: r.reason ?? '실패' }), cache: handOff ? 'handed-off' : 'live' });
          if (prefix && key) consumed.push({ stepIndex: steps.length - 1, key });
          // 이어받은 act 의 녹화 = 재생이 한 앞 액션 + 에이전트가 이어서 한 액션(시작 전제는 원래 녹화의 것). 검증 뒤 커밋되면 옛 녹화를 덮어 고친다
          if (r.ok && r.recording && cacheMode === 'read-write' && key) {
            const actions = prefix ? [...prefix.entry.actions.slice(0, prefix.done.length), ...r.recording.actions] : r.recording.actions;
            const start = prefix ? prefix.entry.start : { ...(r.startApp ? { app: r.startApp } : {}) };
            if (actions.length <= CACHE_LIMITS.actions) {
              const entry: CacheEntry = { schema: CACHE_SCHEMA, createdAt: new Date().toISOString(), recordedBy: { ...(options.agentId ? { agentId: options.agentId } : {}) }, start, actions, end: r.recording.end };
              staged.push({ stepIndex: steps.length - 1, key, entry });
            }
          }
          if (!r.ok) throw new AgentActError(`agent.act ${JSON.stringify(goal)} 실패: ${r.reason}`);
        },
        assert: (statement) => judgeStep('assert', 'agent.assert', statement, (executor) => judgeAssert(engine, statement, { executor, secrets: secretBox, pii: pii ?? false })).then(() => undefined),
        waitFor: (condition, o) => judgeStep('waitFor', 'agent.waitFor', condition, (executor) => judgeWaitFor(engine, condition, { executor, secrets: secretBox, pii: pii ?? false, ...o })).then(() => undefined),
        extract: (what, type) => judgeStep('extract', 'agent.extract', what, (executor) => judgeExtract(engine, what, type, { executor, secrets: secretBox, pii: pii ?? false })).then((r) => r.value!),
      },
      attemptNo,
      secret(name) {
        if (!SECRET_NAME.test(name)) throw new SecretMissingError(`비밀값 이름 ${JSON.stringify(name)}: 대문자로 시작하는 대문자·숫자·_ 여야 함`);
        const value = secretStore.get(name);
        if (value === undefined || value === '') throw new SecretMissingError(`비밀값 ${name} 이 없음: 환경변수 ${SECRET_ENV_PREFIX}${name} 또는 runTests 의 secrets 저장소에 넣는다`);
        try { secretBox.add(name, value); } catch (err) { throw new SecretMissingError(err instanceof Error ? err.message : String(err)); }
        attemptSecrets.add(name);
        return secretPlaceholder(name);
      },
    };

    try {
      // 시도마다 처음 화면에서 시작한다(실패 직후 restart 로 앱 상태는 이미 버렸다)
      await session('open');
      await tc.fn(fixtures);
      return finish('passed', undefined, await settleCache());
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      // 기기가 없거나 모델 실행기 설정이 틀렸으면 테스트 판정이 아니다(재시도해도 같다)
      const deviceGone = error instanceof EngineError && error.code === 'device-unavailable';
      const blocked = deviceGone || error instanceof ModelConfigError || error instanceof SecretMissingError;
      await capture(attemptId).catch((err: unknown) => attemptWarnings.push(`아티팩트 저장 실패: ${errorMessage(err)}`));
      // 실패한 시도가 남긴 앱 상태를 바로 버린다(재시도·다음 테스트·마지막 테스트 모두). 기기가 없으면 restart 도 안 되므로 건너뛴다
      if (!deviceGone) await session('restart').catch((err: unknown) => attemptWarnings.push(`restart 실패: ${errorMessage(err)}`));
      const cache = await settleCache(error);
      return finish(blocked ? 'blocked' : 'failed', error, cache);
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
      // 트리는 값 일치로 가린다(secure 가 아닌 칸에 입력한 비밀값). 스크린샷 픽셀은 가릴 수 없다 — 아티팩트 디렉터리는 비밀로 다룬다
      await fs.writeFile(path.join(options.artifactsDir, treeKey), JSON.stringify({ root: hideDeep(obs.root), atomic: obs.atomic ?? null }, null, 2));
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
