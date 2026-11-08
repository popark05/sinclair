// run 워커(device-fleet 04): 러너의 테스트 등록이 프로세스 전역이라 한 프로세스에서는 run 이 하나씩만 돈다.
// 데몬은 run 마다 같은 bin 을 숨은 명령 `__worker` 로 띄워 IPC 로 일을 맡기고, 워커는 지금의 executeRun 을 그대로 돌린다(스풀도 직접 쓴다).
// 워커는 USB 를 잡지 않는다: mobile 은 데몬이 연 디바이스 레이어 HTTP JSON-RPC(127.0.0.1, 토큰)로만 lease 받은 기기를 조작하고,
// 기기 준비(깨우기·잠금·예열)와 정리는 데몬이 워커 전후로 한다. 데몬이 죽으면 워커도 곧바로 끝난다(run 은 버려진 Run 으로 대체된다).
import { spawn } from 'node:child_process';
import { createMobileEngine, rpcOverHttp } from '@sinclair/engine-mobile';
import type { RunArgs } from './args.ts';
import type { RegisteredRun } from './control-plane-client.ts';
import { EXIT, executeRun, type ExitCode } from './run-once.ts';

/** 워커가 start 를 기다리는 최대 시간 */
const START_TIMEOUT_MS = 30_000;

/** 데몬이 연 디바이스 RPC 와 그 위에서 쓸 기기(mobile 만) */
export interface WorkerDevice { rpcPort: number; rpcToken: string; deviceId: string; label: string }
export type ToWorker =
  | { type: 'start'; args: RunArgs; run: RegisteredRun; files: string[]; device?: WorkerDevice }
  | { type: 'cancel'; reason: string };
export type FromWorker = { type: 'log'; line: string } | { type: 'done'; code: ExitCode };

/** 워커 쪽: IPC 로 start 를 받아 run 하나를 돌리고 done 을 보낸 뒤 끝난다 */
export async function workerMain(): Promise<ExitCode> {
  if (!process.send) { console.error('__worker 는 데몬이 IPC 로 띄울 때만 쓴다'); return EXIT.config; }
  const send = (m: FromWorker): void => { process.send?.(m); };
  // 터미널 Ctrl-C·SIGTERM 은 프로세스 그룹 전체에 간다: 워커는 무시하고 데몬이 보내는 cancel 로만 멈춘다(현재 테스트까지 마치는 의미를 지키려고)
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  process.channel?.ref(); // 일하는 동안 IPC 가 프로세스를 붙잡는다(bin 셸이 unref 해 둔 것을 되돌림)
  const canceller = new AbortController();
  // 데몬이 사라지면(IPC 끊김: 크래시·SIGKILL) 곧바로 끝낸다. 현재 테스트를 마치고 cancelled 로 보고하면 그 Run 은 "끝난" 것이 되어
  // 재시도 정책의 버려진 Run → 대체 Run 경로를 타지 못한다(취소된 Run 은 자동 대체되지 않는다). 데몬 시절과 같이 run.finished 없이 남겨 대체되게 한다.
  // 계획된 종료(SIGTERM)는 데몬이 cancel 을 보내므로 현재 테스트를 마치는 의미가 그대로다
  process.on('disconnect', () => process.exit(143));
  // start 가 오지 않으면 끝낸다: 잘못 띄워진 워커(예: IPC 를 전달하지 않는 bin 재실행 셸을 거침)가 영영 남지 않게
  const start = await new Promise<Extract<ToWorker, { type: 'start' }> | undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), START_TIMEOUT_MS);
    process.on('message', (m: ToWorker) => {
      if (m.type === 'start') { clearTimeout(t); resolve(m); }
      else if (m.type === 'cancel') canceller.abort(new Error(m.reason));
    });
  });
  if (!start) { console.error(`__worker: ${START_TIMEOUT_MS / 1000}초 안에 start 를 받지 못해 끝냄`); return EXIT.config; }
  const { args, run, files, device } = start;
  const code = await executeRun(args, run, files, {
    log: (line) => send({ type: 'log', line }),
    signal: canceller.signal,
    ...(device ? {
      createEngine: async () => {
        const engine = createMobileEngine(rpcOverHttp({ port: device.rpcPort, token: device.rpcToken }), { deviceId: device.deviceId, ...(args.app ? { appId: args.app } : {}) });
        // 정리(앱 종료·홈)는 데몬이 한다. 여기서는 세션만 되돌린다
        return { engine, deviceId: device.deviceId, deviceLabel: device.label, dispose: async () => { await engine.session?.restart().catch(() => undefined); } };
      },
    } : {}),
  });
  send({ type: 'done', code });
  process.channel?.unref();
  return code;
}

/** 데몬 쪽: 워커를 띄워 run 하나를 맡기고 종료 코드를 기다린다. signal 이 abort 되면 cancel 을 보낸다.
 *  워커가 done 없이 죽으면(SIGKILL 등) EXIT.incomplete — 그 run 은 heartbeat 가 끊겨 control-plane 의 버려진 Run 규칙으로 정리된다 */
export function runInWorker(command: readonly string[], start: Extract<ToWorker, { type: 'start' }>, opts: { log: (line: string) => void; signal: AbortSignal; onSpawn?: (pid: number) => void }): Promise<ExitCode> {
  return new Promise((resolve) => {
    const [cmd, ...cmdArgs] = command;
    const child = spawn(cmd!, [...cmdArgs, '__worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, SINCLAIR_AGENT_WORKER: '1' } });
    if (child.pid) opts.onSpawn?.(child.pid);
    let code: ExitCode | undefined;
    const onAbort = (): void => { if (child.connected) child.send({ type: 'cancel', reason: opts.signal.reason instanceof Error ? opts.signal.reason.message : String(opts.signal.reason) } satisfies ToWorker); };
    child.on('message', (m: FromWorker) => {
      if (m.type === 'log') opts.log(m.line);
      else if (m.type === 'done') code = m.code;
    });
    child.on('spawn', () => {
      child.send(start satisfies ToWorker);
      if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
    });
    child.on('error', (err) => { opts.log(`워커를 띄우지 못함: ${err.message}`); });
    child.on('exit', (exitCode, sig) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (code === undefined) opts.log(`워커가 결과 없이 끝남(${sig ?? `exit ${exitCode}`}): 이 run 은 heartbeat 가 끊겨 버려진 Run 으로 정리된다`);
      resolve(code ?? EXIT.incomplete);
    });
  });
}
