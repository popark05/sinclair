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

export interface ClaimedRun { run: RegisteredRun & { lease: { agentId: string; expiresAt: string } }; leaseTtlMs: number; suite?: { tests: string; tags?: string[]; retries?: number } }

export interface DaemonDeps extends RunOnceDeps {
  /** 중단 신호. abort 되면 진행 중 run 을 마치고 루프를 나온다 */
  signal?: AbortSignal;
  /** 테스트용: 한 번에 끝내는 run 수 상한 */
  maxRuns?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface DaemonSummary { runs: Array<{ runId: string; targetId: string; exitCode: ExitCode; leaseLost?: boolean }>; resumed: number; stoppedBy: 'signal' | 'maxRuns' }

/** heartbeat 하한. lease 가 아주 짧게 설정돼도 서버를 초당 수십 번 두드리지 않는다 */
const MIN_HEARTBEAT_MS = 1_000;

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
      // Cycle 이 정한 재시도 횟수가 노드 설정보다 우선한다(QA 담당자가 Cycle 단위로 정책을 고른다)
      const retries = claimed.suite?.retries ?? args.retries;
      log(`run ${run.runId} 클레임 (cycle ${run.cycleId}, target ${targetId}, tests ${testsDir}${retries !== undefined ? `, retries ${retries}` : ''})`);

      // lease 의 1/3 마다 heartbeat: 두 번 놓쳐도 만료 전에 한 번 더 기회가 있다.
      // lease 를 잃으면(not-owner: 만료 뒤 다른 에이전트가 가져감) heartbeat 를 멈추고 경고한다. 러너는 테스트 중간에 멈출 수 없어 run 은 끝까지 돌고,
      // 그 결과는 같은 runId 로 보고된다(알려진 한계 — 재시도 정책 티켓에서 다룬다). 실제 창은 "클레임 뒤 첫 이벤트 전" 으로 좁다: 이벤트가 있는 Run 은 재클레임되지 않는다.
      let leaseLost = false;
      const heartbeatTimer = setInterval(() => {
        void heartbeat(args.controlPlane, run.runId, agentId, deps.fetch).then((r) => {
          if (r === 'ok') return;
          log(`heartbeat ${run.runId}: ${r}`);
          if (r === 'not-owner' || r === 'no-run') { leaseLost = true; clearInterval(heartbeatTimer); }
        });
      }, Math.max(MIN_HEARTBEAT_MS, Math.floor(leaseTtlMs / 3)));
      heartbeatTimer.unref?.();
      let code: ExitCode;
      try {
        const files = await collectTestFiles(testsDir);
        const { targets: _targets, pollMs: _poll, ...runArgs } = args; // RunArgs 에 데몬 전용 필드가 섞이지 않게
        code = await executeRun({ ...runArgs, cycle: run.cycleId, target: targetId, run: run.runId, tests: testsDir, ...(retries !== undefined ? { retries } : {}) }, run, files, deps);
      } catch (err) {
        log(`run ${run.runId} 준비 실패: ${err instanceof Error ? err.message : String(err)}`);
        code = EXIT.config;
      } finally {
        clearInterval(heartbeatTimer);
      }
      if (leaseLost) log(`경고: run ${run.runId} 의 lease 를 잃은 채 끝냄 — 다른 에이전트가 같은 Run 을 보고했을 수 있다`);
      summary.runs.push({ runId: run.runId, targetId, exitCode: code, ...(leaseLost ? { leaseLost: true } : {}) });
      if (deps.maxRuns !== undefined && summary.runs.length >= deps.maxRuns) { summary.stoppedBy = 'maxRuns'; return summary; }
    }
    if (!worked && !deps.signal?.aborted) await sleep(args.pollMs ?? DEFAULT_POLL_MS);
  }
  log('데몬 종료');
  return summary;
}
