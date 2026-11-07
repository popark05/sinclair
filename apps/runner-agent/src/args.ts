// `sinclair-agent run` 인자: 플래그 > 환경변수(SINCLAIR_AGENT_*) > 기본값. 옵션 표 하나가 파서·도움말·환경변수 이름을 만든다.
import * as path from 'node:path';
import { parseArgs } from 'node:util';

export interface RunArgs {
  /** control-plane 주소, 예: http://127.0.0.1:4780 */
  controlPlane: string;
  cycle: string;
  target: string;
  /** `*.sinclair.ts` 를 모을 디렉터리 */
  tests: string;
  engine: 'fake' | 'mobile';
  /** 지정하면 새로 발급하지 않고 이 Run 으로 보고한다 */
  run?: string;
  /** mobile 엔진의 기기 시리얼. 없으면 꽂힌 첫 기기 */
  device?: string;
  /** mobile 엔진이 session.open 에서 띄울 앱 */
  app?: string;
  /** 실패 스냅샷 디렉터리 */
  artifacts?: string;
  /** locator 액션 기한(ms). 없으면 러너 기본 10초 */
  timeoutMs?: number;
  /** 이 노드의 식별자(run.started.agentId). 기본 호스트명 */
  agent?: string;
  /** 스풀 디렉터리(이벤트를 먼저 쓰는 곳). 기본 OS 데이터 디렉터리/sinclair/spool */
  spool: string;
  /** mobile: 헬퍼 APK 파일. 없으면 env → 번들 → 리포 빌드 → 릴리스 다운로드 순으로 찾는다 */
  helperApk?: string;
  /** 헬퍼 APK 다운로드 캐시. 기본 OS 데이터 디렉터리/sinclair/cache/helper */
  helperCache: string;
}

/** OS 데이터 디렉터리/sinclair/cache/helper */
export function defaultHelperCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return path.join(path.dirname(defaultSpoolDir(env, platform)), 'cache', 'helper');
}

/** OS 관례의 사용자 데이터 디렉터리 아래 sinclair/spool (control-plane 의 defaultDataDir 와 같은 규칙) */
export function defaultSpoolDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  const data = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'));
  return path.join(data, 'sinclair', 'spool');
}

export class AgentConfigError extends Error {}

const ENGINES = ['fake', 'mobile'] as const;

interface OptionSpec { readonly name: string; readonly key: string; readonly env: string; readonly required: boolean; readonly help: string }

/** 옵션 표로 parseArgs 를 돌리고 플래그 > 환경변수 순으로 값을 모은다. 빈 문자열은 미설정. 필수 누락·모르는 옵션은 AgentConfigError */
function parseWithTable(options: readonly OptionSpec[], argv: string[], env: NodeJS.ProcessEnv): { help: true; values?: undefined } | { help?: undefined; values: Record<string, string> } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { ...Object.fromEntries(options.map((o) => [o.name, { type: 'string' as const }])), help: { type: 'boolean' as const, short: 'h' } },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const quoted = msg.match(/'(--?[^']+)'/)?.[1];
    if (/Unknown option/.test(msg)) throw new AgentConfigError(`모르는 옵션: ${quoted ?? msg}`);
    if (/argument missing/.test(msg)) throw new AgentConfigError(`${quoted ?? '옵션'} 에 값이 필요함`);
    throw new AgentConfigError(msg);
  }
  if (values.help) return { help: true };
  const out: Record<string, string> = {};
  for (const o of options) {
    const v = values[o.name];
    const picked = (typeof v === 'string' ? v : env[o.env]) || undefined;
    if (picked === undefined) { if (o.required) throw new AgentConfigError(`--${o.name} 이 필요함 [${o.env}]`); continue; }
    out[o.key] = picked;
  }
  return { values: out };
}

const helpTable = (options: readonly OptionSpec[]): string => options.map((o) => `  --${o.name.padEnd(14)} <값>  ${o.required ? '(필수) ' : ''}${o.help} [${o.env}]`).join('\n');

const positiveInt = (name: string, text: string | undefined, min = 0): number | undefined => {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || Number(text) < min) throw new AgentConfigError(`--${name} 은 ${min} 이상의 정수여야 함: ${text}`);
  return Number(text);
};

const OPTIONS = [
  { name: 'control-plane', key: 'controlPlane', env: 'SINCLAIR_AGENT_CONTROL_PLANE', required: true, help: 'control-plane 주소 (예: http://127.0.0.1:4780)' },
  { name: 'cycle', key: 'cycle', env: 'SINCLAIR_AGENT_CYCLE', required: true, help: 'Cycle id' },
  { name: 'target', key: 'target', env: 'SINCLAIR_AGENT_TARGET', required: true, help: '타깃 id (Cycle 의 targets 중 하나)' },
  { name: 'tests', key: 'tests', env: 'SINCLAIR_AGENT_TESTS', required: true, help: '테스트 디렉터리 (*.sinclair.ts, 이름순)' },
  { name: 'engine', key: 'engine', env: 'SINCLAIR_AGENT_ENGINE', required: false, help: 'fake|mobile (기본 mobile)' },
  { name: 'run', key: 'run', env: 'SINCLAIR_AGENT_RUN', required: false, help: '이미 등록된 Run id (없으면 발급)' },
  { name: 'device', key: 'device', env: 'SINCLAIR_AGENT_DEVICE', required: false, help: 'mobile: 기기 시리얼 (없으면 첫 기기)' },
  { name: 'app', key: 'app', env: 'SINCLAIR_AGENT_APP', required: false, help: 'mobile: session.open 이 띄울 앱 id' },
  { name: 'artifacts', key: 'artifacts', env: 'SINCLAIR_AGENT_ARTIFACTS', required: false, help: '실패 스냅샷 디렉터리' },
  { name: 'timeout', key: 'timeoutMs', env: 'SINCLAIR_AGENT_TIMEOUT', required: false, help: 'locator 액션 기한 ms (기본 10000)' },
  { name: 'agent', key: 'agent', env: 'SINCLAIR_AGENT_ID', required: false, help: '이 노드의 id (기본 호스트명; 한 머신에 에이전트를 여럿 띄우면 서로 다르게 줘야 lease 가 구분된다). run.started.agentId' },
  { name: 'spool', key: 'spool', env: 'SINCLAIR_AGENT_SPOOL', required: false, help: '스풀 디렉터리 (기본 OS 데이터 디렉터리/sinclair/spool). 서버가 없어도 이벤트가 여기 남는다' },
  { name: 'helper-apk', key: 'helperApk', env: 'SINCLAIR_AGENT_HELPER_APK', required: false, help: 'mobile: 헬퍼 APK 파일. 없으면 번들 → 리포 빌드 → SINCLAIR_AGENT_HELPER_URL 다운로드(sha256 검증) 순' },
  { name: 'helper-cache', key: 'helperCache', env: 'SINCLAIR_AGENT_HELPER_CACHE', required: false, help: '헬퍼 APK 다운로드 캐시 (기본 OS 데이터 디렉터리/sinclair/cache/helper)' },
] as const;

export const RUN_HELP = `사용법: sinclair-agent run [옵션]

${helpTable(OPTIONS)}
  --help

종료 코드: 0 전부 통과, 1 실패 있음, 2 기기 불가(blocked), 3 설정·등록 오류
`;

export const RESUME_HELP = `사용법: sinclair-agent resume [옵션]

  --spool <dir>           스풀 디렉터리 (기본 OS 데이터 디렉터리/sinclair/spool) [SINCLAIR_AGENT_SPOOL]
  --control-plane <url>   스풀 meta 의 주소 대신 쓸 control-plane [SINCLAIR_AGENT_CONTROL_PLANE]
  --help

스풀에 남은 run 들을 같은 eventId 로 이어 보내고, 다 보낸 run 의 파일은 지운다. 종료 코드: 0 전부 완료, 4 미완 run 있음, 3 설정 오류
`;


export interface ResumeArgs { spool: string; controlPlane?: string }

export function parseResumeArgs(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ResumeArgs | { help: true } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { spool: { type: 'string' }, 'control-plane': { type: 'string' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (err) {
    throw new AgentConfigError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) return { help: true };
  const spool = (typeof values.spool === 'string' ? values.spool : env.SINCLAIR_AGENT_SPOOL) || defaultSpoolDir(env, platform);
  const controlPlane = (typeof values['control-plane'] === 'string' ? values['control-plane'] : env.SINCLAIR_AGENT_CONTROL_PLANE) || undefined;
  if (controlPlane) { try { new URL(controlPlane); } catch { throw new AgentConfigError(`--control-plane 은 URL 이어야 함: ${controlPlane}`); } }
  return { spool, ...(controlPlane ? { controlPlane } : {}) };
}

export function parseRunArgs(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): RunArgs | { help: true } {
  const parsed = parseWithTable(OPTIONS, argv, env);
  if (parsed.help) return { help: true };
  const out = parsed.values;
  try { new URL(out.controlPlane!); } catch { throw new AgentConfigError(`--control-plane 은 URL 이어야 함: ${out.controlPlane}`); }
  const engine = out.engine ?? 'mobile';
  if (!(ENGINES as readonly string[]).includes(engine)) throw new AgentConfigError(`--engine 은 ${ENGINES.join('|')} 중 하나여야 함: ${engine}`);
  const { timeoutMs: timeoutText, ...rest } = out;
  const timeoutMs = positiveInt('timeout', timeoutText);
  return { ...rest, engine, spool: out.spool ?? defaultSpoolDir(env, platform), helperCache: out.helperCache ?? defaultHelperCacheDir(env, platform), ...(timeoutMs !== undefined ? { timeoutMs } : {}) } as unknown as RunArgs;
}

/** daemon 옵션: run 의 표에서 cycle/target/run 을 빼고 targets/poll 을 더한다 */
const DAEMON_OPTIONS: readonly OptionSpec[] = [
  OPTIONS.find((o) => o.name === 'control-plane')!,
  { name: 'targets', key: 'targets', env: 'SINCLAIR_AGENT_TARGETS', required: true, help: '이 노드가 맡는 타깃 id 들, 쉼표 구분' },
  { ...OPTIONS.find((o) => o.name === 'tests')!, help: 'Cycle 에 suite 가 없을 때 쓸 기본 테스트 디렉터리' },
  ...OPTIONS.filter((o) => ['engine', 'device', 'app', 'artifacts', 'timeout', 'agent', 'spool', 'helper-apk', 'helper-cache'].includes(o.name)),
  { name: 'poll', key: 'pollMs', env: 'SINCLAIR_AGENT_POLL', required: false, help: '대기 중인 Run 이 없을 때 다시 묻는 간격 ms (기본 5000, 최소 100)' },
];

export const DAEMON_HELP = `사용법: sinclair-agent daemon [옵션]

${helpTable(DAEMON_OPTIONS)}
  --help

시작할 때 스풀을 이어 보내고, 타깃마다 Run 을 클레임해 실행·보고를 반복한다. SIGTERM/SIGINT 는 진행 중 run 을 마친 뒤 멈춘다.
종료 코드: 0 모든 run 통과, 1 실패·blocked·오류가 있던 run 있음, 3 설정 오류
`;

export interface DaemonCliArgs extends Omit<RunArgs, 'cycle' | 'target' | 'run'> { targets: string[]; pollMs?: number }

export function parseDaemonArgs(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): DaemonCliArgs | { help: true } {
  const parsed = parseWithTable(DAEMON_OPTIONS, argv, env);
  if (parsed.help) return { help: true };
  const out = parsed.values;
  try { new URL(out.controlPlane!); } catch { throw new AgentConfigError(`--control-plane 은 URL 이어야 함: ${out.controlPlane}`); }
  const targets = out.targets!.split(',').map((t) => t.trim()).filter(Boolean);
  if (targets.length === 0) throw new AgentConfigError('--targets 가 비어 있음 (쉼표 구분)');
  const engine = out.engine ?? 'mobile';
  if (!(ENGINES as readonly string[]).includes(engine)) throw new AgentConfigError(`--engine 은 ${ENGINES.join('|')} 중 하나여야 함: ${engine}`);
  const timeoutMs = positiveInt('timeout', out.timeoutMs);
  const pollMs = positiveInt('poll', out.pollMs, 100); // 100ms 미만은 서버를 두드리기만 한다
  const { targets: _t, pollMs: _p, timeoutMs: _m, ...rest } = out;
  return { ...rest, targets, engine, spool: out.spool ?? defaultSpoolDir(env, platform), helperCache: out.helperCache ?? defaultHelperCacheDir(env, platform), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(pollMs !== undefined ? { pollMs } : {}) } as unknown as DaemonCliArgs;
}
