// run 하나를 끝까지: 테스트 파일 수집 → Run 등록 → 엔진 → runTests + HTTP Reporter → 요약·종료 코드.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentFromEnv, ModelConfigError, type AgentSetup } from '@sinclair/agent';
import { runTests, type Reporter } from '@sinclair/runner';
import { AgentConfigError, type RunArgs } from './args.ts';
import { ControlPlaneError, registerRun, type RegisteredRun } from './control-plane-client.ts';
import { createEngine, type EngineHandle } from './engines.ts';
import { HelperApkError } from './helper-apk.ts';
import { createSpoolReporter } from './spool.ts';

/** 종료 코드. 셸 스크립트·CI 가 분기한다. incomplete 는 resume 전용(미완 run 이 남음) */
/** 5 cancelled: lease 상실·종료 신호로 run 이 중단돼 남은 테스트가 돌지 않음(blocked 와 달리 기기 문제가 아니다). 데몬 안에서만 생긴다(`run` 명령은 취소 신호를 받지 않는다).
 *  실패(1)·blocked(2)보다 우선한다: 보고가 불완전하다는 뜻이 먼저이고 케이스별 결과는 Cycle 뷰에 있다 */
export const EXIT = { ok: 0, testsFailed: 1, blocked: 2, config: 3, incomplete: 4, cancelled: 5 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface RunOnceDeps {
  log?: (line: string) => void;
  createEngine?: (args: RunArgs, log: (line: string) => void) => Promise<EngineHandle>;
  /** 03(스풀) 이 HTTP Reporter 를 감싼 Reporter 로 바꾼다 */
  createReporter?: (args: RunArgs, run: RegisteredRun) => Reporter;
  /** agent.act 설정(실행기·한도). 기본은 환경변수(SINCLAIR_AGENT_*, 키는 ANTHROPIC_API_KEY)로 만든 Claude 실행기 */
  agent?: AgentSetup;
  /** 러너 취소 신호(데몬이 lease 상실·종료 신호 때 abort). 진행 중 테스트는 마치고 나머지는 skipped, run 은 cancelled */
  signal?: AbortSignal;
}

/** 디렉터리의 *.sinclair.ts 를 이름순으로. 없거나 비면 설정 오류 */
export async function collectTestFiles(dir: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { throw new AgentConfigError(`테스트 디렉터리를 읽을 수 없음: ${dir}`); }
  const files = names.filter((n) => n.endsWith('.sinclair.ts')).sort().map((n) => path.join(dir, n));
  if (files.length === 0) throw new AgentConfigError(`${dir} 에 *.sinclair.ts 가 없음`);
  return files;
}

/** 기본 Reporter 는 디스크 스풀: 서버가 없어도 이벤트가 남고 `sinclair-agent resume` 이 이어 보낸다 */
const defaultReporter = (args: RunArgs, run: RegisteredRun): Reporter => createSpoolReporter({ dir: args.spool, runId: run.runId, controlPlane: args.controlPlane, cycleId: run.cycleId, targetId: run.targetId });

/** 테스트 파일 수집 → Run 등록 → executeRun. 데몬(04)은 클레임한 Run 으로 executeRun 을 직접 부른다 */
export async function runOnce(args: RunArgs, deps: RunOnceDeps = {}): Promise<ExitCode> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let files: string[];
  let run: RegisteredRun;
  try {
    // 잘못된 SINCLAIR_AGENT_* 는 Run 을 등록하기 전에 드러낸다(키가 없는 것은 agent.act 를 쓰는 테스트만의 문제라 여기서 막지 않는다)
    if (!deps.agent) agentFromEnv(process.env);
    files = await collectTestFiles(path.resolve(args.tests));
    try {
      run = await registerRun(args.controlPlane, args.cycle, args.target, args.run);
      log(`run ${run.runId} 등록 (cycle ${args.cycle}, target ${args.target}, 테스트 파일 ${files.length}개)`);
    } catch (err) {
      // --run 으로 이미 등록된 Run 을 받았는데 서버에 닿지 않으면(status 없음) 그대로 진행한다: 이벤트는 스풀에 남고 resume 이 보낸다.
      // 서버가 응답했는데 거부(404/409)한 경우는 설정 오류다
      if (!(args.run && err instanceof ControlPlaneError && err.status === undefined)) throw err;
      run = { runId: args.run, cycleId: args.cycle, targetId: args.target };
      log(`control-plane 에 닿지 않아 지정된 run ${run.runId} 으로 진행 (이벤트는 스풀에 남음): ${err.message}`);
    }
  } catch (err) {
    log(`설정·등록 오류: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.config;
  }
  return executeRun(args, run, files, deps);
}

/** 등록된 Run 하나를 실행하고 보고한다. 엔진을 못 만들면 run.started + run.finished(infra-failed) 만 보고해 Cycle 에 blocked 가 드러난다 */
export async function executeRun(args: RunArgs, run: RegisteredRun, files: string[], deps: RunOnceDeps = {}): Promise<ExitCode> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const agentId = args.agent ?? os.hostname();
  const reporter = (deps.createReporter ?? defaultReporter)(args, run);

  let agent: AgentSetup;
  try {
    agent = deps.agent ?? agentFromEnv(process.env);
  } catch (err) {
    if (!(err instanceof ModelConfigError)) throw err;
    log(`설정 오류: ${err.message}`);
    return EXIT.config;
  }

  let handle: EngineHandle;
  try {
    handle = await (deps.createEngine ?? createEngine)(args, log);
  } catch (err) {
    log(`${err instanceof HelperApkError ? '헬퍼 APK 없음(기기 불가)' : '엔진 준비 실패(기기 불가)'}: ${err instanceof Error ? err.message : String(err)}`);
    const base = () => ({ schema: 1 as const, eventId: randomUUID(), runId: run.runId, at: new Date().toISOString() });
    await reporter.onEvent({ ...base(), type: 'run.started', cycleId: run.cycleId, targetId: run.targetId, agentId });
    await reporter.onEvent({ ...base(), type: 'run.finished', state: 'infra-failed' });
    await reporter.flush?.().catch((e: unknown) => log(`보고 실패: ${e instanceof Error ? e.message : String(e)}`));
    await reporter.close?.();
    return EXIT.blocked;
  }

  try {
    // Reporter 가 재시도 예산을 알려 주면 러너의 flush 기한을 그에 맞춘다(기본 10초면 스풀의 60초 예산이 무의미해진다)
    const flushBudgetMs = (reporter as { flushBudgetMs?: number }).flushBudgetMs;
    const report = await runTests(files, {
      engine: handle.engine, reporter, runId: run.runId, cycleId: run.cycleId, targetId: run.targetId, agentId, agent,
      ...(flushBudgetMs !== undefined ? { reporterFlushTimeoutMs: flushBudgetMs } : {}),
      ...(handle.deviceId ? { deviceId: handle.deviceId } : {}), ...(args.artifacts ? { artifactsDir: args.artifacts } : {}), ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.retries !== undefined ? { retries: args.retries } : {}), ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const s = report.summary;
    const stats = (reporter as { stats?: { sent: number; accepted: number; duplicate: number; rejected: number; retries: number } }).stats;
    log(`결과: passed ${s.passed}, failed ${s.failed}, blocked ${s.blocked}, skipped ${s.skipped}${stats ? ` / 전송 ${stats.sent}건(accepted ${stats.accepted}, duplicate ${stats.duplicate}, rejected ${stats.rejected}, retries ${stats.retries})` : ''}`);
    for (const t of report.tests) if (t.result !== 'passed') log(`  ${t.result}: ${t.name}${t.error ? ` — ${t.error}` : ''}`);
    for (const w of report.warnings ?? []) log(`  경고: ${w}`);
    if (report.cancelled) { log(`run ${run.runId} 중단(cancelled): ${report.cancelled.reason}`); return EXIT.cancelled; }
    if (s.blocked > 0) return EXIT.blocked;
    return s.failed > 0 ? EXIT.testsFailed : EXIT.ok;
  } finally {
    await handle.dispose().catch((err: unknown) => log(`엔진 정리 실패: ${err instanceof Error ? err.message : String(err)}`));
  }
}
