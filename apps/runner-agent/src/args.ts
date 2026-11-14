// `sinclair-agent run` 인자: 플래그 > 환경변수(SINCLAIR_AGENT_*) > 기본값. 옵션 표 하나가 파서·도움말·환경변수 이름을 만든다.
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { CACHE_MODES, type CacheMode } from '@sinclair/runner';

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
  /** 실패 스냅샷 디렉터리. 없으면 스풀 옆 artifacts/(올린 뒤 지운다) */
  artifacts?: string;
  /** 실패 스냅샷을 control-plane 에 올리는가: on(기본) | off */
  uploadArtifacts?: 'on' | 'off';
  /** locator 액션 기한(ms). 없으면 러너 기본 10초 */
  timeoutMs?: number;
  /** failed 테스트 재시도 횟수(0~5). 데몬은 Cycle 의 suite.retries 가 있으면 그것을 우선한다 */
  retries?: number;
  /** 데몬 전용(CLI 옵션 아님): 대체 Run 이 건너뛸, 앞 Run 에서 결과가 확정된 testId(클레임의 skipTests) */
  skipTests?: string[];
  /** 이 노드의 식별자(run.started.agentId). 기본 호스트명 */
  agent?: string;
  /** 스풀 디렉터리(이벤트를 먼저 쓰는 곳). 기본 OS 데이터 디렉터리/sinclair/spool */
  spool: string;
  /** mobile: 헬퍼 APK 파일. 없으면 env → 번들 → 리포 빌드 → 릴리스 다운로드 순으로 찾는다 */
  helperApk?: string;
  /** 헬퍼 APK 다운로드 캐시. 기본 OS 데이터 디렉터리/sinclair/cache/helper */
  helperCache: string;
  /** 녹화 캐시 모드(control-plane 공유 저장). 없으면 read-write */
  cache?: CacheMode;
}

/** OS 데이터 디렉터리/sinclair/cache/helper */
export const defaultHelperCacheDir = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string => path.join(defaultDataDir(env, platform), 'cache', 'helper');

/** OS 관례의 사용자 데이터 디렉터리 아래 sinclair/ (control-plane 의 defaultDataDir 와 같은 규칙; apps 끼리 import 하지 않아 따로 둔다) */
export function defaultDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  const data = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'));
  return path.join(data, 'sinclair');
}
export const defaultSpoolDir = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string => path.join(defaultDataDir(env, platform), 'spool');

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

const positiveInt = (name: string, text: string | undefined, min = 0, max = Infinity): number | undefined => {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) throw new AgentConfigError(`--${name} 은 ${min} 이상${Number.isFinite(max) ? ` ${max} 이하` : ''}의 정수여야 함: ${text}`);
  return Number(text);
};
/** 러너 MAX_RETRIES 와 같은 값(test/args.test.ts 가 세 패키지의 상수를 함께 읽어 확인한다) */
export const MAX_RETRIES = 5;

const OPTIONS = [
  { name: 'control-plane', key: 'controlPlane', env: 'SINCLAIR_AGENT_CONTROL_PLANE', required: true, help: 'control-plane 주소 (예: http://127.0.0.1:4780)' },
  { name: 'cycle', key: 'cycle', env: 'SINCLAIR_AGENT_CYCLE', required: true, help: 'Cycle id' },
  { name: 'target', key: 'target', env: 'SINCLAIR_AGENT_TARGET', required: true, help: '타깃 id (Cycle 의 targets 중 하나)' },
  { name: 'tests', key: 'tests', env: 'SINCLAIR_AGENT_TESTS', required: true, help: '테스트 디렉터리 (*.sinclair.ts, 이름순)' },
  { name: 'engine', key: 'engine', env: 'SINCLAIR_AGENT_ENGINE', required: false, help: 'fake|mobile (기본 mobile)' },
  { name: 'run', key: 'run', env: 'SINCLAIR_AGENT_RUN', required: false, help: '이미 등록된 Run id (없으면 발급)' },
  { name: 'device', key: 'device', env: 'SINCLAIR_AGENT_DEVICE', required: false, help: 'mobile: 기기 시리얼 (없으면 첫 기기)' },
  { name: 'app', key: 'app', env: 'SINCLAIR_AGENT_APP', required: false, help: 'mobile: session.open 이 띄울 앱 id' },
  { name: 'artifacts', key: 'artifacts', env: 'SINCLAIR_AGENT_ARTIFACTS', required: false, help: '실패 스냅샷 디렉터리 (기본 스풀 옆 artifacts/ — 올린 뒤 지운다)' },
  { name: 'upload-artifacts', key: 'uploadArtifacts', env: 'SINCLAIR_AGENT_UPLOAD_ARTIFACTS', required: false, help: 'on(기본)|off — 실패 스냅샷(스크린샷·화면 트리)을 control-plane 에 올린다. 스크린샷은 화면 그대로라 개인정보가 보일 수 있다' },
  { name: 'timeout', key: 'timeoutMs', env: 'SINCLAIR_AGENT_TIMEOUT', required: false, help: 'locator 액션 기한 ms (기본 10000)' },
  { name: 'retries', key: 'retries', env: 'SINCLAIR_AGENT_RETRIES', required: false, help: 'failed 테스트 재시도 횟수 0~5 (기본 0). daemon 은 Cycle 의 suite.retries 가 있으면 그것을 우선' },
  { name: 'cache', key: 'cache', env: 'SINCLAIR_AGENT_CACHE', required: false, help: '녹화 캐시 off|read-only|read-write|strict (기본 read-write). agent.act 를 control-plane 에 녹화해 두고 다음부터 모델 없이 재생, 어긋나면 에이전트가 이어받음. strict 는 녹화와 다르면 실패' },
  { name: 'agent', key: 'agent', env: 'SINCLAIR_AGENT_ID', required: false, help: '이 노드의 id (기본 호스트명; 한 머신에 에이전트를 여럿 띄우면 서로 다르게 줘야 lease 가 구분된다). run.started.agentId' },
  { name: 'spool', key: 'spool', env: 'SINCLAIR_AGENT_SPOOL', required: false, help: '스풀 디렉터리 (기본 OS 데이터 디렉터리/sinclair/spool). 서버가 없어도 이벤트가 여기 남는다' },
  { name: 'helper-apk', key: 'helperApk', env: 'SINCLAIR_AGENT_HELPER_APK', required: false, help: 'mobile: 헬퍼 APK 파일. 없으면 번들 → 리포 빌드 → SINCLAIR_AGENT_HELPER_URL 다운로드(sha256 검증) 순' },
  { name: 'helper-cache', key: 'helperCache', env: 'SINCLAIR_AGENT_HELPER_CACHE', required: false, help: '헬퍼 APK 다운로드 캐시 (기본 OS 데이터 디렉터리/sinclair/cache/helper)' },
] as const;

/** agent.act(모델 실행기) 환경변수. 플래그는 없다: 키는 명령줄(ps·셸 기록)에 남기지 않는다 */
const AGENT_ENV_HELP = `agent.act(모델) 환경변수:
  ANTHROPIC_API_KEY                 Claude API 키(또는 ANTHROPIC_AUTH_TOKEN·ANTHROPIC_PROFILE). 없으면 agent.act 를 쓰는 테스트만 blocked(agent-config)
  ANTHROPIC_BASE_URL                API 주소(기본 공식 API)
  SINCLAIR_AGENT_MODEL              모델 (기본 claude-sonnet-5-5; claude-opus-5-5, claude-haiku-5-5)
  SINCLAIR_AGENT_MODEL_EFFORT       low|medium|high|xhigh|max (기본 medium)
  SINCLAIR_AGENT_MODEL_TIMEOUT_MS   모델 요청 하나의 기한 (기본 60000)
  SINCLAIR_AGENT_MODEL_RETRIES      일시 오류(연결·429·5xx) 재시도 (기본 2)
  SINCLAIR_AGENT_MODEL_MAX_TOKENS   요청 하나의 최대 출력 토큰 (기본 8192)
  SINCLAIR_AGENT_MODEL_PIXELS       1 이면 화면 이미지도 보낸다 (기본 0: 접근성 트리만)
  SINCLAIR_AGENT_ACT_MAX_TURNS      act 하나의 턴 한도 (기본 20)
  SINCLAIR_AGENT_LEDGER_BUDGET      한 턴 요청(user 메시지)의 추정 토큰 예산 (기본 8000). 넘으면 오래된 턴 요약·사유 자르기·최근 턴 줄이기·화면 자르기 순
  SINCLAIR_AGENT_LEDGER_SUMMARY_MODEL  접힌 8턴 묶음을 요약할 모델 (예: claude-haiku-5-5, 기본 없음 = 결정적 요약)
  SINCLAIR_AGENT_ACT_TIMEOUT_MS     act 하나의 시간 한도 (기본 120000)
  SINCLAIR_AGENT_ACT_PERMISSION     권한 요청 창 자동 복구: allow(기본, 앱 사용 중에만 허용) | deny
  SINCLAIR_AGENT_ACT_SAFETY_PIXELS  1 이면 액션 전 안전망이 대상 영역의 픽셀 변화(트리에 없는 덮개)도 본다 (기본 0)
  SINCLAIR_SECRET_<이름>            테스트의 secret('<이름>') 값. 모델·이벤트·로그·screen-tree 에는 자리표시 {{secret:<이름>}} 만 남는다. 없으면 그 테스트는 blocked(secret-missing)
  SINCLAIR_AGENT_PII                화면 개인정보 가림 on(기본)|off — 이메일·전화번호·주민등록번호·카드번호·IMEI 를 모델 요청과 기록에서 <종류> 로
  SINCLAIR_AGENT_PII_TERMS          패턴으로 못 찾는 개인정보(기기 소유자 이름·계정명 등), 쉼표 구분
  NODE_EXTRA_CA_CERTS               사내망(SSL 인터셉션)이면 CA 묶음 PEM (예: $HOME/.certs/all-system-certs.pem)
`;

export const RUN_HELP = `사용법: sinclair-agent run [옵션]

${helpTable(OPTIONS)}
  --help

종료 코드: 0 전부 통과, 1 실패 있음, 2 기기 불가(blocked), 3 설정·등록 오류
테스트 파일(*.sinclair.ts)은 Node 의 타입 스트리핑으로 그대로 로드한다(Node 22.18+ 또는 24).

${AGENT_ENV_HELP}`;

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

function cacheMode(v: string | undefined): CacheMode {
  const m = v ?? 'read-write';
  if (!(CACHE_MODES as readonly string[]).includes(m)) throw new AgentConfigError(`--cache 는 ${CACHE_MODES.join('|')} 중 하나여야 함: ${m}`);
  return m as CacheMode;
}

export function parseRunArgs(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): RunArgs | { help: true } {
  const parsed = parseWithTable(OPTIONS, argv, env);
  if (parsed.help) return { help: true };
  const out = parsed.values;
  try { new URL(out.controlPlane!); } catch { throw new AgentConfigError(`--control-plane 은 URL 이어야 함: ${out.controlPlane}`); }
  const engine = out.engine ?? 'mobile';
  if (!(ENGINES as readonly string[]).includes(engine)) throw new AgentConfigError(`--engine 은 ${ENGINES.join('|')} 중 하나여야 함: ${engine}`);
  const { timeoutMs: timeoutText, retries: retriesText, ...rest } = out;
  const timeoutMs = positiveInt('timeout', timeoutText);
  const retries = positiveInt('retries', retriesText, 0, MAX_RETRIES);
  if (out.uploadArtifacts !== undefined && out.uploadArtifacts !== 'on' && out.uploadArtifacts !== 'off') throw new AgentConfigError(`--upload-artifacts 는 on|off 여야 함: ${out.uploadArtifacts}`);
  const cache = cacheMode(out.cache);
  return { ...rest, cache, engine, spool: out.spool ?? defaultSpoolDir(env, platform), helperCache: out.helperCache ?? defaultHelperCacheDir(env, platform), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(retries !== undefined ? { retries } : {}) } as unknown as RunArgs;
}

/** daemon 옵션: run 의 표에서 cycle/target/run 을 빼고 targets/poll 을 더한다 */
const DAEMON_OPTIONS: readonly OptionSpec[] = [
  OPTIONS.find((o) => o.name === 'control-plane')!,
  { name: 'targets', key: 'targets', env: 'SINCLAIR_AGENT_TARGETS', required: false, help: '이 노드가 맡는 이름 타깃들, 쉼표 구분. 조건 타깃(플랫폼·모델·OS)은 기기가 맞으면 선언 없이 받는다' },
  { ...OPTIONS.find((o) => o.name === 'tests')!, help: 'Cycle 에 suite 가 없을 때 쓸 기본 테스트 디렉터리' },
  ...OPTIONS.filter((o) => ['engine', 'device', 'app', 'artifacts', 'upload-artifacts', 'timeout', 'retries', 'cache', 'agent', 'spool', 'helper-apk', 'helper-cache'].includes(o.name)),
  { name: 'poll', key: 'pollMs', env: 'SINCLAIR_AGENT_POLL', required: false, help: '대기 중인 Run 이 없을 때 다시 묻는 간격 ms (기본 5000, 최소 100)' },
  { name: 'fake-devices', key: 'fakeDevices', env: 'SINCLAIR_AGENT_FAKE_DEVICES', required: false, help: '--engine fake 전용: 보고할 가짜 기기 목록 JSON 파일([{id, platform, model, osVersion, connection, helper?, locked?}]). 없으면 fake-<agent> 한 대' },
  { name: 'concurrency', key: 'concurrency', env: 'SINCLAIR_AGENT_CONCURRENCY', required: false, help: '동시에 돌리는 run 수 상한 (기본: 쓸 수 있는 기기 수, run 마다 워커 프로세스)' },
];

export const DAEMON_HELP = `사용법: sinclair-agent daemon [옵션]

${helpTable(DAEMON_OPTIONS)}
  --help

시작할 때 스풀을 이어 보내고, 타깃마다 Run 을 클레임해 실행·보고를 반복한다. SIGTERM/SIGINT 는 진행 중 테스트 하나만 마치고 나머지를 skipped 로 보고(run cancelled)한 뒤 멈춘다. heartbeat 가 not-owner 면 같은 방식으로 run 을 중단한다.
꽂힌 기기를 control-plane Fleet 에 주기적으로 보고하고, 쓸 수 있는 기기(USB 디버깅 승인·헬퍼 준비·잠금 없음)만 클레임에 내놓는다.
run 은 run 마다 워커 프로세스로 돌고 기기마다 동시에 돈다(--concurrency 로 상한). USB 는 데몬만 잡고 워커는 데몬의 로컬 디바이스 RPC 로 기기를 조작한다.
화면이 잠긴 기기는 한 번 깨우고 위로 스와이프해 본다(비보안 잠금은 풀린다). 보안 잠금(PIN·패턴)이면 화면을 다시 끄고 사람이 풀 때까지 다시 깨우지 않는다 — 기기 노드의 폰은 잠금 없음 또는 '화면 켜짐 상태 유지'로 두는 것을 권한다.
종료 코드: 0 모든 run 통과(lease 상실·종료 신호로 중단된 run 은 실패로 세지 않는다), 1 실패·blocked·오류가 있던 run 있음, 3 설정 오류

${AGENT_ENV_HELP}`;

export interface DaemonCliArgs extends Omit<RunArgs, 'cycle' | 'target' | 'run'> { targets: string[]; pollMs?: number; concurrency?: number; fakeDevices?: string }

export function parseDaemonArgs(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): DaemonCliArgs | { help: true } {
  const parsed = parseWithTable(DAEMON_OPTIONS, argv, env);
  if (parsed.help) return { help: true };
  const out = parsed.values;
  try { new URL(out.controlPlane!); } catch { throw new AgentConfigError(`--control-plane 은 URL 이어야 함: ${out.controlPlane}`); }
  const targets = (out.targets ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const engine = out.engine ?? 'mobile';
  if (!(ENGINES as readonly string[]).includes(engine)) throw new AgentConfigError(`--engine 은 ${ENGINES.join('|')} 중 하나여야 함: ${engine}`);
  const timeoutMs = positiveInt('timeout', out.timeoutMs);
  const pollMs = positiveInt('poll', out.pollMs, 100); // 100ms 미만은 서버를 두드리기만 한다
  const concurrency = positiveInt('concurrency', out.concurrency, 1);
  if (out.fakeDevices !== undefined && engine !== 'fake') throw new AgentConfigError('--fake-devices 는 --engine fake 에서만 쓴다');
  const retries = positiveInt('retries', out.retries, 0, MAX_RETRIES);
  const { targets: _t, pollMs: _p, timeoutMs: _m, retries: _r, concurrency: _cc, ...rest } = out;
  if (out.uploadArtifacts !== undefined && out.uploadArtifacts !== 'on' && out.uploadArtifacts !== 'off') throw new AgentConfigError(`--upload-artifacts 는 on|off 여야 함: ${out.uploadArtifacts}`);
  const cache = cacheMode(out.cache);
  return { ...rest, cache, targets, engine, spool: out.spool ?? defaultSpoolDir(env, platform), helperCache: out.helperCache ?? defaultHelperCacheDir(env, platform), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(retries !== undefined ? { retries } : {}), ...(pollMs !== undefined ? { pollMs } : {}), ...(concurrency !== undefined ? { concurrency } : {}) } as unknown as DaemonCliArgs;
}
