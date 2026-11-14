// 메인 쪽 작업 프로세스 관리(ADR 0005): plain Node 로 띄우고, 상태를 알리고, 요청을 id 로 짝짓는다.
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseFromWorker, type ToWorker, type WorkerStatus } from '../shared/studio-ipc.ts';

/** 작업 프로세스용 Node: SINCLAIR_STUDIO_NODE, 없으면 PATH 의 node(개발). 설치본은 동봉 Node 를 이 변수로 넘긴다(패키징 티켓) */
export function resolveWorkerNode(env: NodeJS.ProcessEnv): string {
  return env.SINCLAIR_STUDIO_NODE || 'node';
}

export interface WorkerHostOptions {
  node: string;
  script: string;
  onStatus?: (s: WorkerStatus) => void;
  env?: NodeJS.ProcessEnv;
}

export interface WorkerHost {
  status(): WorkerStatus;
  /** ready 가 되면 풀린다. 띄우지 못하거나 먼저 죽으면 거부 */
  ready(): Promise<void>;
  ping(opts?: { delayMs?: number }): Promise<{ roundTripMs: number; node: string }>;
  kill(): void;
  /** 정상 종료(IPC 끊기 → 작업 프로세스가 스스로 끝남), 늦으면 SIGKILL */
  stop(): Promise<void>;
}

export function createWorkerHost(opts: WorkerHostOptions): WorkerHost {
  let state: WorkerStatus = { state: 'starting' };
  const set = (s: WorkerStatus): void => { state = s; opts.onStatus?.(s); };
  const pending = new Map<string, { resolve: (v: { roundTripMs: number; node: string }) => void; reject: (e: Error) => void; sentAt: number }>();
  let readyResolve!: () => void, readyReject!: (e: Error) => void;
  const readyP = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
  readyP.catch(() => {}); // 아무도 기다리지 않아도 처리되지 않은 거부로 남지 않게

  set({ state: 'starting' });
  let child: ChildProcess;
  try {
    child = fork(opts.script, [], { execPath: opts.node, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: opts.env ?? process.env, serialization: 'advanced' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    set({ state: 'exited', error });
    readyReject(new Error(`작업 프로세스를 띄우지 못함: ${error}`));
    return stubHost();
  }

  const fail = (error: string): void => {
    if (state.state === 'exited') return;
    set({ ...state, state: 'exited', error });
    readyReject(new Error(`작업 프로세스를 띄우지 못함: ${error}`));
    for (const [, p] of pending) p.reject(new Error(`작업 프로세스가 끝남: ${error}`));
    pending.clear();
  };
  child.on('error', (err) => fail(err.message));
  child.on('exit', (code, signal) => fail(signal ? `신호 ${signal}` : `종료 코드 ${code}`));
  child.on('message', (raw) => {
    const m = parseFromWorker(raw);
    if (!m) return;
    if (m.type === 'ready') { set({ state: 'ready', node: m.node, pid: m.pid }); readyResolve(); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p.resolve({ roundTripMs: Date.now() - p.sentAt, node: m.node });
  });

  const host: WorkerHost = {
    status: () => ({ ...state }),
    ready: () => readyP,
    ping: (o = {}) => new Promise((resolve, reject) => {
      if (state.state !== 'ready') { reject(new Error(`작업 프로세스가 준비되지 않음(${state.state})`)); return; }
      const id = randomUUID();
      pending.set(id, { resolve, reject, sentAt: Date.now() });
      const msg: ToWorker = { type: 'ping', id, ...(o.delayMs ? { delayMs: o.delayMs } : {}) };
      child.send(msg);
    }),
    kill: () => { child.kill('SIGKILL'); },
    stop: async () => {
      if (state.state === 'exited') return;
      const gone = new Promise<void>((r) => child.once('exit', () => r()));
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await gone;
      clearTimeout(timer);
    },
  };
  return host;

  function stubHost(): WorkerHost {
    return { status: () => ({ ...state }), ready: () => readyP, ping: async () => { throw new Error('작업 프로세스가 없음'); }, kill: () => {}, stop: async () => {} };
  }
}
