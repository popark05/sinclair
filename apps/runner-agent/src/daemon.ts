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
import { runInWorker, type WorkerDevice } from './worker.ts';

export interface DaemonArgs extends Omit<RunArgs, 'cycle' | 'target' | 'run'> {
  /** 이 노드가 맡겠다고 선언하는 이름 타깃들(문자열 타깃용, 하위 호환). 조건 타깃만 쓰면 비어도 된다 */
  targets: string[];
  /** 대기 중인 Run 이 없을 때 다시 물어보는 간격(ms, 기본 5초: Cycle 생성 뒤 몇 초 안에 돌기 시작하면서 서버에 부담이 없을 만큼) */
  pollMs?: number;
  /** 동시에 돌리는 run 수 상한(워커 모드). 기본은 쓸 수 있는 기기 수(기기마다 하나) */
  concurrency?: number;
}

export interface ClaimedRun { run: RegisteredRun & { lease: { agentId: string; expiresAt: string; deviceId?: string } }; leaseTtlMs: number; suite?: { tests: string; tags?: string[]; retries?: number }; warning?: string }

export interface DaemonDeps extends RunOnceDeps {
  /** 중단 신호. abort 되면 진행 중 run 에 취소를 전파해 진행 중 테스트 하나만 마치고(나머지 skipped, run cancelled) 루프를 나온다 */
  signal?: AbortSignal;
  /** 테스트용: 한 번에 끝내는 run 수 상한 */
  maxRuns?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** run 마다 띄울 워커 명령(node + 플래그 + bin). 있으면 워커 모드: 기기마다 동시에(device-fleet 04). bin 의 main 이 자기 execArgv 를 넣어 넘긴다 —
   *  리포 체크아웃의 bin 재실행 셸을 거치면 IPC 가 손자 프로세스에 닿지 않으므로 변환 플래그가 이미 붙은 명령이어야 한다 */
  workerCommand?: readonly string[];
  /** 테스트용: 워커를 띄웠을 때(run 과 pid) */
  onWorkerSpawn?: (runId: string, pid: number) => void;
  /** 테스트용: Fleet 에 보고할 기기 목록. 없으면 fake 엔진은 가짜 기기 하나, mobile 은 데몬이 소유한 디바이스 백엔드의 목록 */
  inventory?: () => Promise<NodeDevice[]>;
}

export interface DaemonSummary { runs: Array<{ runId: string; targetId: string; exitCode: ExitCode; leaseLost?: boolean; cancelled?: string }>; resumed: number; stoppedBy: 'signal' | 'maxRuns' }

/** heartbeat 하한. lease 가 아주 짧게 설정돼도 서버를 초당 수십 번 두드리지 않는다 */
const MIN_HEARTBEAT_MS = 1_000;

const DEFAULT_POLL_MS = 5_000;

/** devices: 이 노드가 내놓는 후보 기기. 있으면 control-plane 이 그중 빈 기기를 lease 해 준다(없으면 구버전처럼 기기 없는 lease) */
/** targetId 가 없으면 서버가 이 노드의 기기와 선언한 이름 타깃(targets)으로 Run 을 고른다(device-fleet 03). 있으면 그 타깃만(기존 방식) */
export async function claimRun(controlPlane: string, targetId: string | undefined, agentId: string, doFetch: typeof fetch = fetch, devices?: readonly string[], targets?: readonly string[]): Promise<ClaimedRun | undefined> {
  const base = controlPlane.replace(/\/$/, '');
  const res = await doFetch(`${base}/runs/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, ...(targetId ? { targetId } : {}), ...(devices ? { devices } : {}), ...(targets?.length ? { targets } : {}) }) });
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
  const summary: DaemonSummary = { runs: [], resumed: 0, stoppedBy: 'signal' };

  // 지난번에 못 보낸 이벤트부터
  const resumed = await resumeSpool({ dir: args.spool, controlPlane: args.controlPlane, ...(deps.fetch ? { fetch: deps.fetch } : {}), log });
  summary.resumed = resumed.resumed.length;
  for (const w of resumed.warnings) log(`  경고: ${w}`);
  log(`데몬 시작: agent ${agentId}, 이름 타깃 ${args.targets.length ? args.targets.join(', ') : '없음(조건 타깃만)'}, control-plane ${args.controlPlane}`);

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
  /** 구버전 control-plane(targetId 없는 클레임을 모름)이면 타깃마다 청한다 */
  let legacyClaims = false;
  const runDeps: RunOnceDeps = ownsBackend ? { ...deps, createEngine: async (a, l) => { const n = await ensureNode(); if (!n) throw new Error('디바이스 백엔드를 열지 못함'); return n.engineFor(a, l); } } : deps;

  // Fleet 보고: 시작할 때 한 번, 그 뒤 서버 TTL 의 1/3 마다. PUT 이 실패해도 클레임은 계속한다(클레임 후보는 보고가 아니라 읽은 인벤토리다)
  let reportTimer: NodeJS.Timeout | undefined;
  let lastReportError = '';
  let reportsStopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const report = (): Promise<void> => (inFlight = reportOnce());
  /** 지금 바로 보고: 진행 중인 보고가 있으면 끝나기를 기다린 뒤 그 보고가 건 타이머를 지우고 새로 보고한다 — 보고 사슬이 언제나 하나다 */
  // 여러 run 이 동시에 끝나 여러 번 불려도 사슬은 하나: 진행 중 보고 뒤에 줄을 세워 하나씩(각자 앞 보고가 건 타이머를 지우고 새로 건다)
  const reportNow = (): Promise<void> => (inFlight = inFlight.then(() => { clearTimeout(reportTimer); return reportsStopped ? undefined : reportOnce(); }));
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
    // 워커 모드(bin 으로 띄운 데몬): run 마다 워커 프로세스, 기기마다 하나씩 동시에(상한 --concurrency). 라이브러리로 부르면 같은 프로세스에서 하나씩(러너가 프로세스당 하나)
    const workerMode = !!deps.workerCommand;
    const limit = workerMode ? (args.concurrency ?? Number.POSITIVE_INFINITY) : 1;
    const active = new Map<string, { deviceId: string | undefined; done: Promise<void> }>();
    let claimedCount = 0;

    /** 클레임한 Run 하나: heartbeat, (워커 모드면) 기기 준비 → 워커 → 정리, 즉시 보고, 요약 */
    /** fallbackDevice: lease 에 기기가 없을 때(구버전 control-plane) 이 run 이 쓸 기기 — 워커 모드에서 데몬 USB 를 워커가 열지 않게, 같은 기기에 run 이 겹치지 않게 */
    const runClaimed = async (claimed: ClaimedRun, fallbackDevice: string | undefined): Promise<void> => {
      const { run, leaseTtlMs } = claimed;
      const targetId = run.targetId;
      if (claimed.warning) log(`클레임 경고: ${claimed.warning}`);
      // lease 받은 기기로 돈다. 그 기기를 못 찾으면 엔진 준비가 실패해 blocked(infra-failed)로 보고되고, run 이 끝나 기기 lease 도 풀린다
      const leasedDevice = claimed.run.lease.deviceId ?? fallbackDevice;
      const testsDir = path.resolve(claimed.suite?.tests ?? args.tests);
      // Cycle 이 정한 재시도 횟수가 노드 설정보다 우선한다(QA 담당자가 Cycle 단위로 정책을 고른다)
      const retries = claimed.suite?.retries ?? args.retries;
      log(`run ${run.runId} 클레임 (cycle ${run.cycleId}, target ${targetId}${leasedDevice ? `, 기기 …${leasedDevice.slice(-4)}` : ''}, tests ${testsDir}${retries !== undefined ? `, retries ${retries}` : ''})`);
      // 동시에 여러 run 이 돌면 로그가 섞이므로 워커 모드에서는 run 을 앞에 붙인다
      const runLog = workerMode ? (l: string): void => log(`[run …${run.runId.slice(-8)}] ${l}`) : log;

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
          runLog(`heartbeat ${run.runId}: ${r}`);
          if (r === 'not-owner' || r === 'replaced' || r === 'no-run') { leaseLost = true; clearInterval(heartbeatTimer); canceller.abort(new Error('lease 를 잃음')); }
        });
      }, Math.max(MIN_HEARTBEAT_MS, Math.floor(leaseTtlMs / 3)));
      heartbeatTimer.unref?.();
      let code: ExitCode;
      try {
        const files = await collectTestFiles(testsDir);
        const { targets: _targets, pollMs: _poll, concurrency: _c, ...runArgs } = args; // RunArgs 에 데몬 전용 필드가 섞이지 않게
        const fullArgs: RunArgs = { ...runArgs, cycle: run.cycleId, target: targetId, run: run.runId, tests: testsDir, ...(retries !== undefined ? { retries } : {}), ...(leasedDevice ? { device: leasedDevice } : {}) };
        if (!workerMode) code = await executeRun(fullArgs, run, files, { ...runDeps, signal: canceller.signal, log: runLog });
        else {
          // mobile: 데몬이 기기를 준비하고(USB 는 데몬만) 워커에는 디바이스 RPC 주소만 준다. 준비가 실패하면 같은 프로세스에서 blocked 로 보고한다(테스트는 돌지 않는다)
          let device: WorkerDevice | undefined;
          let prepError: unknown;
          if (node && leasedDevice) {
            try {
              const prep = await node.prepare(fullArgs, runLog);
              const rpc = await node.serveRpc();
              device = { rpcPort: rpc.port, rpcToken: rpc.token, deviceId: prep.deviceId, label: prep.label };
            } catch (err) { prepError = err; }
          }
          try {
            code = prepError !== undefined
              ? await executeRun(fullArgs, run, files, { ...deps, log: runLog, signal: canceller.signal, createEngine: async () => { throw prepError; } })
              : await runInWorker(deps.workerCommand!, { type: 'start', args: fullArgs, run, files, ...(device ? { device } : {}) }, { log: runLog, signal: canceller.signal, ...(deps.onWorkerSpawn ? { onSpawn: (pid: number) => deps.onWorkerSpawn!(run.runId, pid) } : {}) });
          } finally {
            if (node && leasedDevice) await node.cleanup(leasedDevice, args.app);
          }
        }
      } catch (err) {
        runLog(`run ${run.runId} 준비 실패: ${err instanceof Error ? err.message : String(err)}`);
        code = EXIT.config;
      } finally {
        clearInterval(heartbeatTimer);
        deps.signal?.removeEventListener('abort', onDaemonAbort);
      }
      // 신호가 왔다는 것이 아니라 run 이 실제로 중단됐을 때만 사유를 남긴다(마지막 테스트 도중 신호면 run 은 finished)
      const cancelled = code === EXIT.cancelled ? (canceller.signal.reason instanceof Error ? canceller.signal.reason.message : String(canceller.signal.reason)) : undefined;
      if (leaseLost) runLog(cancelled ? `run ${run.runId}: lease 를 잃어 중단 — 진행 중이던 테스트까지만 보고됐고 나머지는 skipped(cancelled)` : `경고: run ${run.runId} 의 lease 를 잃었지만 남은 테스트 없이 끝남`);
      // run 이 끝나면 주기 보고를 기다리지 않고 바로 다시 보고한다: 기기가 빠지거나(blocked) run 도중 잠겼으면(run 중에는 잠금을 다시 보지 않는다) Fleet 에 지금 상태가 곧 보인다. lease 는 run.finished 로 이미 풀렸다
      await reportNow();
      summary.runs.push({ runId: run.runId, targetId, exitCode: code, ...(leaseLost ? { leaseLost: true } : {}), ...(cancelled ? { cancelled } : {}) });
    };

    while (!deps.signal?.aborted) {
      let claimedNow = false;
      const room = active.size < limit && (deps.maxRuns === undefined || claimedCount < deps.maxRuns);
      // 폴링마다 클레임 한 번: 서버가 이 노드에 줄 Run 을 고른다 — 이름 타깃은 --targets 로 선언한 것, 조건 타깃은 내놓은 기기 중 맞는 것이 있을 때(device-fleet 03)
      if (room) claim: {
        let claimed: ClaimedRun | undefined;
        await refreshCandidates(); // 클레임 직전: 앞 run 이 길었으면 그 사이 상태가 바뀌었을 수 있다
        if (candidateIds.length === 0) {
          // 기기 없는 노드는 클레임하지 않는다(받아도 돌릴 기기가 없다). 조용히 기다리지 않도록 한 번 알린다
          if (!announcedNoCandidates) log(`후보 기기 없음: 클레임하지 않고 기다림${args.device ? ` (--device …${args.device.slice(-4)} 가 목록에 없음)` : ''}`);
          announcedNoCandidates = true;
          break claim;
        }
        announcedNoCandidates = false;
        // 이 데몬의 run 이 쓰는 기기는 후보에서 뺀다(서버의 기기 lease 도 막지만, 끝난 run 의 정리가 남은 기기를 바로 다시 내놓지 않게)
        const inUse = new Set([...active.values()].map((a) => a.deviceId));
        const devices = candidateIds.filter((d) => !inUse.has(d));
        if (devices.length === 0) break claim; // 전부 쓰는 중: run 하나가 끝나기를 기다린다
        try {
          if (!legacyClaims) claimed = await claimRun(args.controlPlane, undefined, agentId, deps.fetch, devices, args.targets);
        } catch (err) {
          // 구버전 control-plane 은 targetId 없는 클레임을 400 으로 거절한다: 이름 타깃이 있으면 예전처럼 타깃마다 청하는 방식으로 바꾼다(조건 타깃은 그 서버에 없다)
          if (err instanceof ControlPlaneError && err.status === 400 && args.targets.length > 0) {
            legacyClaims = true;
            log(`control-plane 이 targetId 없는 클레임을 모름(구버전으로 보임): 이름 타깃(${args.targets.join(', ')})마다 클레임한다`);
          } else { log(`클레임 오류: ${err instanceof Error ? err.message : String(err)}`); break claim; }
        }
        if (legacyClaims) {
          for (const t of args.targets) {
            try { claimed = await claimRun(args.controlPlane, t, agentId, deps.fetch, devices); }
            catch (err) { log(`클레임 오류(${t}): ${err instanceof Error ? err.message : String(err)}`); }
            if (claimed) break;
          }
        }
        if (!claimed) break claim;
        claimedNow = true;
        claimedCount++;
        const runId = claimed.run.runId;
        // 구버전 control-plane 은 기기 lease 를 안 준다: 내놓은 첫 빈 기기를 이 run 의 기기로 삼아 겹치지 않게 한다
        const runDevice = claimed.run.lease.deviceId ?? devices[0];
        const done = runClaimed(claimed, runDevice).finally(() => { active.delete(runId); });
        active.set(runId, { deviceId: runDevice, done });
        if (!workerMode) await done; // 같은 프로세스 모드: 하나씩
      }
      if (deps.maxRuns !== undefined && claimedCount >= deps.maxRuns) {
        await Promise.allSettled([...active.values()].map((a) => a.done));
        summary.stoppedBy = 'maxRuns';
        return summary;
      }
      // 아무것도 못 받았으면 폴링 간격만큼, 그 사이 run 이 끝나면 바로 다시 본다(빈 기기가 생겼다)
      if (!claimedNow && !deps.signal?.aborted) await Promise.race([sleep(args.pollMs ?? DEFAULT_POLL_MS), ...[...active.values()].map((a) => a.done.catch(() => undefined))]);
    }
    // 종료 신호: 각 run 의 취소가 이미 전파됐다. 진행 중 테스트를 마치고 끝나기를 기다린다
    await Promise.allSettled([...active.values()].map((a) => a.done));
    log('데몬 종료');
    return summary;
  } finally {
    reportsStopped = true;
    clearTimeout(reportTimer);
    await inFlight; // 진행 중이던 인벤토리가 백엔드를 쓰는 동안 닫지 않는다
    await node?.close().catch(() => undefined);
  }
}
