// 데몬: 타깃마다 control-plane 에서 대기 중인 Run 을 클레임해 실행·보고하고 다음을 가져온다. 최소 Scheduler.
// 시작 시 스풀을 이어 보내고, run 중에는 lease 의 1/3 마다 heartbeat 한다. 중단 신호가 오면 진행 중 run 을 마친 뒤(스풀 flush·close) 멈춘다.
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunArgs } from './args.ts';
import { AgentConfigError } from './args.ts';
import { ControlPlaneError, type RegisteredRun } from './control-plane-client.ts';
import { collectTestFiles, executeRun, EXIT, type ExitCode, type RunOnceDeps } from './run-once.ts';
import { resumeSpool } from './spool.ts';

export interface DaemonArgs extends Omit<RunArgs, 'cycle' | 'target' | 'run'> {
  /** 이 노드가 맡는 타깃들 */
  targets: string[];
  /** 대기 중인 Run 이 없을 때 다시 물어보는 간격(ms, 기본 5초: Cycle 생성 뒤 몇 초 안에 돌기 시작하면서 서버에 부담이 없을 만큼) */
  pollMs?: number;
}

export interface ClaimedRun { run: RegisteredRun & { lease: { agentId: string; expiresAt: string } }; leaseTtlMs: number; suite?: { tests: string; tags?: string[] } }

export interface DaemonDeps extends RunOnceDeps {
  /** 중단 신호. abort 되면 진행 중 run 을 마치고 루프를 나온다 */
  signal?: AbortSignal;
  /** 테스트용: 한 번에 끝내는 run 수 상한 */
  maxRuns?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface DaemonSummary { runs: Array<{ runId: string; targetId: string; exitCode: ExitCode }>; resumed: number; stoppedBy: 'signal' | 'maxRuns' }

const DEFAULT_POLL_MS = 5_000;

export async function claimRun(controlPlane: string, targetId: string, agentId: string, doFetch: typeof fetch = fetch): Promise<ClaimedRun | undefined> {
  const base = controlPlane.replace(/\/$/, '');
  const res = await doFetch(`${base}/runs/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId, agentId }) });
  if (res.status === 204) return undefined;
  if (res.status !== 200) throw new ControlPlaneError(`클레임 실패 ${res.status}`, res.status);
  return (await res.json()) as ClaimedRun;
}

export async function heartbeat(controlPlane: string, runId: string, agentId: string, doFetch: typeof fetch = fetch): Promise<'ok' | 'not-owner' | 'no-run' | 'error'> {
  try {
    const res = await doFetch(`${controlPlane.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId }) });
    return res.status === 200 ? 'ok' : res.status === 409 ? 'not-owner' : res.status === 404 ? 'no-run' : 'error';
  } catch {
    return 'error';
  }
}

export async function runDaemon(args: DaemonArgs, deps: DaemonDeps = {}): Promise<DaemonSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void { clearTimeout(t); deps.signal?.removeEventListener('abort', done); resolve(); }
    deps.signal?.addEventListener('abort', done, { once: true });
  }));
  const agentId = args.agent ?? os.hostname();
  if (args.targets.length === 0) throw new AgentConfigError('--targets 가 비어 있음');
  const summary: DaemonSummary = { runs: [], resumed: 0, stoppedBy: 'signal' };

  // 지난번에 못 보낸 이벤트부터
  const resumed = await resumeSpool({ dir: args.spool, controlPlane: args.controlPlane, ...(deps.fetch ? { fetch: deps.fetch } : {}), log });
  summary.resumed = resumed.resumed.length;
  for (const w of resumed.warnings) log(`  경고: ${w}`);
  log(`데몬 시작: agent ${agentId}, targets ${args.targets.join(', ')}, control-plane ${args.controlPlane}`);

  while (!deps.signal?.aborted) {
    let worked = false;
    for (const targetId of args.targets) {
      if (deps.signal?.aborted) break;
      let claimed: ClaimedRun | undefined;
      try { claimed = await claimRun(args.controlPlane, targetId, agentId, deps.fetch); }
      catch (err) { log(`클레임 오류(${targetId}): ${err instanceof Error ? err.message : String(err)}`); continue; }
      if (!claimed) continue;
      worked = true;
      const { run, leaseTtlMs } = claimed;
      const testsDir = path.resolve(claimed.suite?.tests ?? args.tests);
      log(`run ${run.runId} 클레임 (cycle ${run.cycleId}, target ${targetId}, tests ${testsDir})`);

      // lease 의 1/3 마다 heartbeat: 두 번 놓쳐도 만료 전에 한 번 더 기회가 있다
      const hb = setInterval(() => { void heartbeat(args.controlPlane, run.runId, agentId, deps.fetch).then((r) => { if (r !== 'ok') log(`heartbeat ${run.runId}: ${r}`); }); }, Math.max(1_000, Math.floor(leaseTtlMs / 3)));
      hb.unref?.();
      let code: ExitCode;
      try {
        const files = await collectTestFiles(testsDir);
        code = await executeRun({ ...args, cycle: run.cycleId, target: targetId, run: run.runId, tests: testsDir }, run, files, deps);
      } catch (err) {
        log(`run ${run.runId} 준비 실패: ${err instanceof Error ? err.message : String(err)}`);
        code = EXIT.config;
      } finally {
        clearInterval(hb);
      }
      summary.runs.push({ runId: run.runId, targetId, exitCode: code });
      if (deps.maxRuns !== undefined && summary.runs.length >= deps.maxRuns) { summary.stoppedBy = 'maxRuns'; return summary; }
    }
    if (!worked && !deps.signal?.aborted) await sleep(args.pollMs ?? DEFAULT_POLL_MS);
  }
  log('데몬 종료');
  return summary;
}
