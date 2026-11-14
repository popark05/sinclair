// 메인 쪽 작업 프로세스 관리(ADR 0005): plain Node 로 띄우고, 상태를 알리고, 요청을 id 로 짝짓는다.
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseFromWorker, type StudioEvent, type StudioRequest, type StudioResponses, type ToWorker, type WorkerStatus } from '../shared/studio-ipc.ts';

/** 작업 프로세스용 Node: SINCLAIR_STUDIO_NODE, 없으면 PATH 의 node(개발). 설치본은 동봉 Node 를 이 변수로 넘긴다(패키징 티켓) */
export function resolveWorkerNode(env: NodeJS.ProcessEnv): string {
  return env.SINCLAIR_STUDIO_NODE || 'node';
}

/** 리포 실행: 워크스페이스 패키지(@sinclair/*)가 TS 원본이라 변환 플래그가 필요하다(runner-agent bin 과 같은 방식). 설치본은 단일 번들로 바꾼다(패키징) */
export const WORKER_EXEC_ARGV = ['--experimental-transform-types', '--no-warnings=ExperimentalWarning'];

export interface WorkerHostOptions {
  node: string;
  script: string;
  onStatus?: (s: WorkerStatus) => void;
  /** 작업 프로세스가 밀어 보낸 이벤트(세션 턴·끝) */
  onEvent?: (e: StudioEvent) => void;
  env?: NodeJS.ProcessEnv;
  /** 작업 프로세스 Node 플래그. 리포에서는 워크스페이스 패키지가 TS 라 --experimental-transform-types */
  execArgv?: string[];
}

export interface WorkerHost {
  status(): WorkerStatus;
  /** ready 가 되면 풀린다. 띄우지 못하거나 먼저 죽으면 거부 */
  ready(): Promise<void>;
  ping(opts?: { delayMs?: number }): Promise<{ roundTripMs: number; node: string }>;
  request<K extends StudioRequest['kind']>(req: Extract<StudioRequest, { kind: K }>): Promise<StudioResponses[K]>;
  kill(): void;
  /** 정상 종료(IPC 끊기 → 작업 프로세스가 스스로 끝남), 늦으면 SIGKILL */
  stop(): Promise<void>;
}

export function createWorkerHost(opts: WorkerHostOptions): WorkerHost {
  let state: WorkerStatus = { state: 'starting' };
  const set = (s: WorkerStatus): void => { state = s; opts.onStatus?.(s); };
  const pending = new Map<string, { resolve: (v: { roundTripMs: number; node: string }) => void; reject: (e: Error) => void; sentAt: number }>();
  const requests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let readyResolve!: () => void, readyReject!: (e: Error) => void;
  const readyP = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
  readyP.catch(() => {}); // 아무도 기다리지 않아도 처리되지 않은 거부로 남지 않게

  set({ state: 'starting' });
  let child: ChildProcess;
  try {
    child = fork(opts.script, [], { execPath: opts.node, execArgv: opts.execArgv ?? WORKER_EXEC_ARGV, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: opts.env ?? process.env, serialization: 'json' });
    // json 인 까닭: Electron 의 Node 와 작업 프로세스의 plain Node 는 V8 버전이 달라 'advanced'(V8 직렬화) 메시지를 서로 풀지 못한다(실기 확인)
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
    for (const [, p] of requests) p.reject(new Error(`작업 프로세스가 끝남: ${error}`));
    pending.clear();
    requests.clear();
  };
  child.on('error', (err) => fail(err.message));
  child.on('exit', (code, signal) => fail(signal ? `신호 ${signal}` : `종료 코드 ${code}`));
  child.on('message', (raw) => {
    const m = parseFromWorker(raw);
    if (!m) return;
    if (m.type === 'ready') { set({ state: 'ready', node: m.node, pid: m.pid }); readyResolve(); return; }
    if (m.type === 'event') { opts.onEvent?.(m.event); return; }
    if (m.type === 'response') {
      const r = requests.get(m.id);
      if (!r) return;
      requests.delete(m.id);
      if (m.ok) r.resolve(m.value); else r.reject(new Error(m.error));
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p.resolve({ roundTripMs: Date.now() - p.sentAt, node: m.node });
  });

  /** 띄우는 중이면 준비될 때까지 기다리고, 이미 끝났으면 거부 */
  const whenReady = (): Promise<void> => (state.state === 'exited' ? Promise.reject(new Error(`작업 프로세스가 끝남: ${state.error ?? ''}`)) : readyP);

  const host: WorkerHost = {
    status: () => ({ ...state }),
    ready: () => readyP,
    ping: (o = {}) => whenReady().then(() => new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject, sentAt: Date.now() });
      const msg: ToWorker = { type: 'ping', id, ...(o.delayMs ? { delayMs: o.delayMs } : {}) };
      child.send(msg);
    })),
    request: (req) => whenReady().then(() => new Promise((resolve, reject) => {
      const id = randomUUID();
      requests.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const msg: ToWorker = { type: 'request', id, request: req };
      child.send(msg);
    })),
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
    return { status: () => ({ ...state }), ready: () => readyP, ping: async () => { throw new Error('작업 프로세스가 없음'); }, request: async () => { throw new Error('작업 프로세스가 없음'); }, kill: () => {}, stop: async () => {} };
  }
}
