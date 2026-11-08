// 데몬: 타깃마다 control-plane 에서 대기 중인 Run 을 클레임해 실행·보고하고 다음을 가져온다. 최소 Scheduler.
// 시작 시 스풀을 이어 보내고, run 중에는 lease 의 1/3 마다 heartbeat 한다. 중단 신호가 오면 진행 중 run 을 마친 뒤(스풀 flush·close) 멈춘다.
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunArgs } from './args.ts';
import { AgentConfigError } from './args.ts';
import { ControlPlaneError, type RegisteredRun } from './control-plane-client.ts';
import { collectTestFiles, executeRun, EXIT, type ExitCode, type RunOnceDeps } from './run-once.ts';
import { resumeSpool } from './spool.ts';
import { nodeDeviceProblem, type NodeDevice } from '@sinclair/protocol';
import { fakeDevice, openAndroidNode, type AndroidNode } from './engines.ts';

export interface DaemonArgs extends Omit<RunArgs, 'cycle' | 'target' | 'run'> {
  /** 이 노드가 맡는 타깃들 */
  targets: string[];
  /** 대기 중인 Run 이 없을 때 다시 물어보는 간격(ms, 기본 5초: Cycle 생성 뒤 몇 초 안에 돌기 시작하면서 서버에 부담이 없을 만큼) */
  pollMs?: number;
}

export interface ClaimedRun { run: RegisteredRun & { lease: { agentId: string; expiresAt: string; deviceId?: string } }; leaseTtlMs: number; suite?: { tests: string; tags?: string[]; retries?: number }; warning?: string }

export interface DaemonDeps extends RunOnceDeps {
  /** 중단 신호. abort 되면 진행 중 run 에 취소를 전파해 진행 중 테스트 하나만 마치고(나머지 skipped, run cancelled) 루프를 나온다 */
  signal?: AbortSignal;
  /** 테스트용: 한 번에 끝내는 run 수 상한 */
  maxRuns?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 테스트용: Fleet 에 보고할 기기 목록. 없으면 fake 엔진은 가짜 기기 하나, mobile 은 데몬이 소유한 디바이스 백엔드의 목록 */
  inventory?: () => Promise<NodeDevice[]>;
}

export interface DaemonSummary { runs: Array<{ runId: string; targetId: string; exitCode: ExitCode; leaseLost?: boolean; cancelled?: string }>; resumed: number; stoppedBy: 'signal' | 'maxRuns' }

/** heartbeat 하한. lease 가 아주 짧게 설정돼도 서버를 초당 수십 번 두드리지 않는다 */
const MIN_HEARTBEAT_MS = 1_000;

const DEFAULT_POLL_MS = 5_000;

/** devices: 이 노드가 내놓는 후보 기기. 있으면 control-plane 이 그중 빈 기기를 lease 해 준다(없으면 구버전처럼 기기 없는 lease) */
export async function claimRun(controlPlane: string, targetId: string, agentId: string, doFetch: typeof fetch = fetch, devices?: readonly string[]): Promise<ClaimedRun | undefined> {
  const base = controlPlane.replace(/\/$/, '');
  const res = await doFetch(`${base}/runs/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId, agentId, ...(devices ? { devices } : {}) }) });
  if (res.status === 204) return undefined;
  if (res.status !== 200) throw new ControlPlaneError(`클레임 실패 ${res.status}`, res.status);
  return (await res.json()) as ClaimedRun;
}

/** replaced: 버려진 Run 으로 정리돼 대체 Run 이 생겼다(409 code replaced). not-owner 와 같이 lease 상실로 다루되 로그에서 구분한다 */
export async function heartbeat(controlPlane: string, runId: string, agentId: string, doFetch: typeof fetch = fetch): Promise<'ok' | 'not-owner' | 'replaced' | 'no-run' | 'error'> {
  try {
    const res = await doFetch(`${controlPlane.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId }) });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      return body.code === 'replaced' ? 'replaced' : 'not-owner';
    }
    return res.status === 200 ? 'ok' : res.status === 404 ? 'no-run' : 'error';
  } catch {
    return 'error';
  }
}

/** Fleet 노드 보고. 응답의 ttlMs 가 다음 보고 간격(TTL/3)의 기준이다 */
export async function reportNode(controlPlane: string, agentId: string, devices: NodeDevice[], doFetch: typeof fetch = fetch): Promise<{ ttlMs: number }> {
  // 답 없는 서버에 매달려 보고 타이머가 영영 다시 걸리지 않는 일이 없도록 기한을 둔다
  const res = await doFetch(`${controlPlane.replace(/\/$/, '')}/fleet/nodes/${encodeURIComponent(agentId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ devices }), signal: AbortSignal.timeout(REPORT_TIMEOUT_MS) });
  if (res.status !== 200) throw new ControlPlaneError(`fleet 보고 ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  const body = (await res.json()) as { ttlMs?: unknown };
  // ttlMs 가 숫자가 아니면 간격이 NaN 이 되어 setTimeout 이 1ms 로 돈다(서버를 두드린다)
  if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) throw new ControlPlaneError(`fleet 보고 응답의 ttlMs 가 올바르지 않음: ${JSON.stringify(body.ttlMs)}`, res.status);
  return { ttlMs: body.ttlMs };
}

/** 보고 간격의 하한·서버가 TTL 을 알려 주기 전 기본값 */
const MIN_REPORT_MS = 1_000;
const DEFAULT_REPORT_MS = 20_000;
const REPORT_TIMEOUT_MS = 10_000;

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

  // mobile 데몬은 디바이스 백엔드를 하나 소유해 인벤토리와 run 들이 같이 쓴다(직접 USB 는 한 프로세스만 잡을 수 있다).
  // 열지 못하면(헬퍼 APK 없음 등) 인벤토리가 비어 클레임하지 않고(기기 없는 노드), 보고 때마다 다시 연다
  const ownsBackend = args.engine === 'mobile' && !deps.createEngine && !deps.inventory; // 테스트가 엔진·인벤토리를 끼우면 USB 를 열지 않는다
  let node: AndroidNode | undefined;
  let lastOpenError = '';
  const ensureNode = async (): Promise<AndroidNode | undefined> => {
    if (node || !ownsBackend) return node;
    try {
      node = await openAndroidNode(args, log);
      if (lastOpenError) log('디바이스 백엔드를 열었음');
      lastOpenError = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastOpenError) log(`디바이스 백엔드를 열지 못함(기기 없는 노드로 보고하고 다음 보고 때 다시 시도): ${msg}`);
      lastOpenError = msg;
    }
    return node;
  };
  await ensureNode();
  // 기기 목록 읽기는 한 길로: 주기 보고(풀기 시도 없음)와 클레임 직전 새로 읽기(잠긴 기기 풀기 시도)가 같은 함수를 쓴다
  const readInventory = async (opts: { tryUnlock?: boolean }): Promise<NodeDevice[]> => {
    if (deps.inventory) return deps.inventory();
    if (ownsBackend) return (await ensureNode())?.inventory(opts) ?? [];
    return args.engine === 'fake' ? [fakeDevice(agentId)] : [];
  };
  // 마지막으로 읽은 기기 목록이 클레임 후보의 바탕이다. 두 길이 겹쳐 읽을 수 있으므로 시작 순서로 번호를 매겨, 나중에 시작한 읽기의 결과만 남긴다
  // (풀기 시도 뒤의 새 결과를 그보다 먼저 시작한 보고의 묵은 결과가 덮지 않게)
  let lastDevices: NodeDevice[] = [];
  let readSeq = 0;
  let appliedSeq = 0;
  const inventory = async (opts: { tryUnlock?: boolean } = {}): Promise<NodeDevice[]> => {
    const seq = ++readSeq;
    const devices = await readInventory(opts);
    if (seq > appliedSeq) { appliedSeq = seq; lastDevices = devices; }
    return devices;
  };
  // 후보: 운영자가 --device 로 고정했으면 그 기기만, 그리고 지금 쓸 수 있는 기기만(잠김·헬퍼 미준비·미승인은 Run 을 받아도 blocked 로 끝난다 — 받지 않고 기다린다).
  // 뺀 기기는 사유가 바뀔 때만 한 줄, 다시 쓸 수 있게 되거나 빠지면 한 줄
  const excludedReason = new Map<string, string>();
  let candidateIds: string[] = [];
  const updateCandidates = (): void => {
    const out: string[] = [];
    for (const d of lastDevices) {
      if (args.device && d.id !== args.device) continue;
      const problem = nodeDeviceProblem(d);
      if (problem) {
        if (excludedReason.get(d.id) !== problem) log(`기기 …${d.id.slice(-4)} 를 후보에서 뺌: ${problem}`);
        excludedReason.set(d.id, problem);
        continue;
      }
      if (excludedReason.delete(d.id)) log(`기기 …${d.id.slice(-4)} 를 다시 후보로: 쓸 수 있음`);
      out.push(d.id);
    }
    for (const id of excludedReason.keys()) if (!lastDevices.some((d) => d.id === id)) { excludedReason.delete(id); log(`기기 …${id.slice(-4)} 가 목록에서 빠짐`); }
    candidateIds = out;
  };
  /** 클레임 직전에 기기 상태를 새로 읽는다(주기 보고는 TTL/3 만큼 묵을 수 있다). 비용: mobile 은 기기 목록(2초 캐시) + 기기마다 잠금 확인(dumpsys) 한 번.
   *  읽기가 실패하면 후보를 비운다(빠진 기기에 Run 을 받아 infra-failed 로 태우지 않게) */
  const refreshCandidates = async (): Promise<void> => {
    try { await inventory({ tryUnlock: true }); } catch (err) {
      log(`인벤토리 읽기 실패(이번엔 클레임하지 않음): ${err instanceof Error ? err.message : String(err)}`);
      lastDevices = []; appliedSeq = readSeq;
    }
    updateCandidates();
  };
  let announcedNoCandidates = false;
  const runDeps: RunOnceDeps = ownsBackend ? { ...deps, createEngine: async (a, l) => { const n = await ensureNode(); if (!n) throw new Error('디바이스 백엔드를 열지 못함'); return n.engineFor(a, l); } } : deps;

  // Fleet 보고: 시작할 때 한 번, 그 뒤 서버 TTL 의 1/3 마다. PUT 이 실패해도 클레임은 계속한다(클레임 후보는 보고가 아니라 읽은 인벤토리다)
  let reportTimer: NodeJS.Timeout | undefined;
  let lastReportError = '';
  let reportsStopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const report = (): Promise<void> => (inFlight = reportOnce());
  /** 지금 바로 보고: 진행 중인 보고가 있으면 끝나기를 기다린 뒤 그 보고가 건 타이머를 지우고 새로 보고한다 — 보고 사슬이 언제나 하나다 */
  const reportNow = async (): Promise<void> => { await inFlight; clearTimeout(reportTimer); if (!reportsStopped) await report(); };
  const reportOnce = async (): Promise<void> => {
    let nextMs = DEFAULT_REPORT_MS;
    try {
      const devices = await inventory();
      // 멈추는 중이면 보내지 않는다: 닫히는 백엔드에서 읽은 덜 채운 목록(잠금 정보 없음 등)이 마지막 보고를 덮어쓰지 않게
      if (reportsStopped) return;
      const { ttlMs } = await reportNode(args.controlPlane, agentId, devices, deps.fetch);
      nextMs = Math.max(MIN_REPORT_MS, Math.floor(ttlMs / 3));
      if (lastReportError || !reportTimer) log(`fleet 보고: 기기 ${devices.length}대`); // 처음과 회복 때만(시리얼은 쓰지 않는다)
      lastReportError = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastReportError) log(`fleet 보고 실패(계속 시도): ${msg}`);
      lastReportError = msg;
    }
    if (!reportsStopped) { reportTimer = setTimeout(() => void report(), nextMs); reportTimer.unref?.(); }
  };
  await report();

  try {
    while (!deps.signal?.aborted) {
      let worked = false;
      for (const targetId of args.targets) {
        if (deps.signal?.aborted) break;
        let claimed: ClaimedRun | undefined;
        await refreshCandidates(); // 타깃마다: 앞 타깃의 run 이 길었으면 그 사이 상태가 바뀌었을 수 있다
        const devices = candidateIds;
        if (devices.length === 0) {
          // 기기 없는 노드는 클레임하지 않는다(받아도 돌릴 기기가 없다). 조용히 기다리지 않도록 한 번 알린다
          if (!announcedNoCandidates) log(`후보 기기 없음: 클레임하지 않고 기다림${args.device ? ` (--device …${args.device.slice(-4)} 가 목록에 없음)` : ''}`);
          announcedNoCandidates = true;
          continue;
        }
        announcedNoCandidates = false;
        try { claimed = await claimRun(args.controlPlane, targetId, agentId, deps.fetch, devices); }
        catch (err) { log(`클레임 오류(${targetId}): ${err instanceof Error ? err.message : String(err)}`); continue; }
        if (!claimed) continue;
        worked = true;
        const { run, leaseTtlMs } = claimed;
        if (claimed.warning) log(`클레임 경고: ${claimed.warning}`);
        // lease 받은 기기로 돈다. 그 기기를 못 찾으면 엔진 준비가 실패해 blocked(infra-failed)로 보고되고, run 이 끝나 기기 lease 도 풀린다
        const leasedDevice = claimed.run.lease.deviceId;
        const testsDir = path.resolve(claimed.suite?.tests ?? args.tests);
        // Cycle 이 정한 재시도 횟수가 노드 설정보다 우선한다(QA 담당자가 Cycle 단위로 정책을 고른다)
        const retries = claimed.suite?.retries ?? args.retries;
        log(`run ${run.runId} 클레임 (cycle ${run.cycleId}, target ${targetId}${leasedDevice ? `, 기기 …${leasedDevice.slice(-4)}` : ''}, tests ${testsDir}${retries !== undefined ? `, retries ${retries}` : ''})`);

        // run 마다 취소 컨트롤러: lease 상실과 데몬 종료 신호가 같은 길로 러너에 닿는다. 러너는 진행 중 테스트를 마치고 나머지를 skipped 로 보고하므로
        // 두 에이전트가 같은 Run 에 보고하는 창은 "현재 테스트 하나" 로 줄고, SIGTERM 도 run 전체가 아니라 테스트 하나 뒤에 멈춘다
        const canceller = new AbortController();
        const onDaemonAbort = (): void => canceller.abort(new Error('종료 신호'));
        if (deps.signal?.aborted) onDaemonAbort(); else deps.signal?.addEventListener('abort', onDaemonAbort, { once: true });
        // lease 의 1/3 마다 heartbeat: 두 번 놓쳐도 만료 전에 한 번 더 기회가 있다.
        // lease 를 잃으면(not-owner: 만료 뒤 다른 에이전트가 가져감 / no-run) 러너를 취소한다
        let leaseLost = false;
        const heartbeatTimer = setInterval(() => {
          void heartbeat(args.controlPlane, run.runId, agentId, deps.fetch).then((r) => {
            if (r === 'ok') return;
            log(`heartbeat ${run.runId}: ${r}`);
            if (r === 'not-owner' || r === 'replaced' || r === 'no-run') { leaseLost = true; clearInterval(heartbeatTimer); canceller.abort(new Error('lease 를 잃음')); }
          });
        }, Math.max(MIN_HEARTBEAT_MS, Math.floor(leaseTtlMs / 3)));
        heartbeatTimer.unref?.();
        let code: ExitCode;
        try {
          const files = await collectTestFiles(testsDir);
          const { targets: _targets, pollMs: _poll, ...runArgs } = args; // RunArgs 에 데몬 전용 필드가 섞이지 않게
          code = await executeRun({ ...runArgs, cycle: run.cycleId, target: targetId, run: run.runId, tests: testsDir, ...(retries !== undefined ? { retries } : {}), ...(leasedDevice ? { device: leasedDevice } : {}) }, run, files, { ...runDeps, signal: canceller.signal });
        } catch (err) {
          log(`run ${run.runId} 준비 실패: ${err instanceof Error ? err.message : String(err)}`);
          code = EXIT.config;
        } finally {
          clearInterval(heartbeatTimer);
          deps.signal?.removeEventListener('abort', onDaemonAbort);
        }
        // 신호가 왔다는 것이 아니라 run 이 실제로 중단됐을 때만 사유를 남긴다(마지막 테스트 도중 신호면 run 은 finished)
        const cancelled = code === EXIT.cancelled ? (canceller.signal.reason instanceof Error ? canceller.signal.reason.message : String(canceller.signal.reason)) : undefined;
        if (leaseLost) log(cancelled ? `run ${run.runId}: lease 를 잃어 중단 — 진행 중이던 테스트까지만 보고됐고 나머지는 skipped(cancelled)` : `경고: run ${run.runId} 의 lease 를 잃었지만 남은 테스트 없이 끝남`);
        // run 이 끝나면 주기 보고를 기다리지 않고 바로 다시 보고한다: 기기가 빠지거나(blocked) run 도중 잠겼으면(run 중에는 잠금을 다시 보지 않는다) Fleet 에 지금 상태가 곧 보인다. lease 는 run.finished 로 이미 풀렸다
        await reportNow();
        summary.runs.push({ runId: run.runId, targetId, exitCode: code, ...(leaseLost ? { leaseLost: true } : {}), ...(cancelled ? { cancelled } : {}) });
        if (deps.maxRuns !== undefined && summary.runs.length >= deps.maxRuns) { summary.stoppedBy = 'maxRuns'; return summary; }
      }
      if (!worked && !deps.signal?.aborted) await sleep(args.pollMs ?? DEFAULT_POLL_MS);
    }
    log('데몬 종료');
    return summary;
  } finally {
    reportsStopped = true;
    clearTimeout(reportTimer);
    await inFlight; // 진행 중이던 인벤토리가 백엔드를 쓰는 동안 닫지 않는다
    await node?.close().catch(() => undefined);
  }
}
