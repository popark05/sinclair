// run 하나를 끝까지: 테스트 파일 수집 → Run 등록 → 엔진 → runTests + HTTP Reporter → 요약·종료 코드.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHttpReporter, runTests } from '@sinclair/runner';
import type { RunArgs } from './args.ts';
import { ControlPlaneError, registerRun } from './control-plane-client.ts';
import { createEngine, type EngineHandle } from './engines.ts';

/** 종료 코드. 셸 스크립트·CI 가 분기한다 */
export const EXIT = { ok: 0, testsFailed: 1, blocked: 2, config: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface RunOnceDeps {
  log?: (line: string) => void;
  createEngine?: (args: RunArgs, log: (line: string) => void) => Promise<EngineHandle>;
  fetch?: typeof fetch;
}

/** 디렉터리의 *.sinclair.ts 를 이름순으로. 없거나 비면 오류 */
export async function collectTestFiles(dir: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { throw new ControlPlaneError(`테스트 디렉터리를 읽을 수 없음: ${dir}`); }
  const files = names.filter((n) => n.endsWith('.sinclair.ts')).sort().map((n) => path.join(dir, n));
  if (files.length === 0) throw new ControlPlaneError(`${dir} 에 *.sinclair.ts 가 없음`);
  return files;
}

export async function runOnce(args: RunArgs, deps: RunOnceDeps = {}): Promise<ExitCode> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let files: string[];
  let run: { runId: string };
  try {
    files = await collectTestFiles(path.resolve(args.tests));
    run = await registerRun(args.controlPlane, args.cycle, args.target, args.run, deps.fetch);
    log(`run ${run.runId} 등록 (cycle ${args.cycle}, target ${args.target}, 테스트 파일 ${files.length}개)`);
  } catch (err) {
    log(`설정·등록 오류: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.config;
  }

  let handle: EngineHandle;
  try {
    handle = await (deps.createEngine ?? createEngine)(args, log);
  } catch (err) {
    log(`엔진 준비 실패(기기 불가): ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.blocked;
  }

  const reporter = createHttpReporter({ url: `${args.controlPlane.replace(/\/$/, '')}/ingest`, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  try {
    const report = await runTests(files, {
      engine: handle.engine, reporter, runId: run.runId, cycleId: args.cycle, targetId: args.target,
      ...(handle.deviceLabel ? { deviceId: handle.deviceLabel } : {}), ...(args.artifacts ? { artifactsDir: args.artifacts } : {}), ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
    const s = report.summary;
    log(`결과: passed ${s.passed}, failed ${s.failed}, blocked ${s.blocked}, skipped ${s.skipped} / 전송 ${reporter.stats.sent}건(accepted ${reporter.stats.accepted}, duplicate ${reporter.stats.duplicate}, rejected ${reporter.stats.rejected}, retries ${reporter.stats.retries})`);
    for (const t of report.tests) if (t.result !== 'passed') log(`  ${t.result}: ${t.name}${t.error ? ` — ${t.error}` : ''}`);
    for (const w of report.warnings ?? []) log(`  경고: ${w}`);
    if (s.blocked > 0) return EXIT.blocked;
    return s.failed > 0 ? EXIT.testsFailed : EXIT.ok;
  } finally {
    await handle.dispose().catch((err: unknown) => log(`엔진 정리 실패: ${err instanceof Error ? err.message : String(err)}`));
  }
}
