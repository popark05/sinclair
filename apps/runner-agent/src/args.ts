// `sinclair-agent run` 인자: 플래그 > 환경변수(SINCLAIR_AGENT_*) > 기본값. 옵션 표 하나가 파서·도움말·환경변수 이름을 만든다.
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
}

export class AgentConfigError extends Error {}

const ENGINES = ['fake', 'mobile'] as const;

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
  { name: 'agent', key: 'agent', env: 'SINCLAIR_AGENT_ID', required: false, help: '이 노드의 id (기본 호스트명). run.started.agentId' },
] as const;

export const RUN_HELP = `사용법: sinclair-agent run [옵션]

${OPTIONS.map((o) => `  --${o.name.padEnd(14)} <값>  ${o.required ? '(필수) ' : ''}${o.help} [${o.env}]`).join('\n')}
  --help

종료 코드: 0 전부 통과, 1 실패 있음, 2 기기 불가(blocked), 3 설정·등록 오류
`;

export function parseRunArgs(argv: string[], env: NodeJS.ProcessEnv): RunArgs | { help: true } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { ...Object.fromEntries(OPTIONS.map((o) => [o.name, { type: 'string' as const }])), help: { type: 'boolean' as const, short: 'h' } },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const quoted = msg.match(/'(--?[^']+)'/)?.[1];
    if (/Unknown option/.test(msg)) throw new AgentConfigError(`모르는 옵션: ${quoted ?? msg}`);
    if (/argument missing/.test(msg)) throw new AgentConfigError(`${quoted ?? '옵션'} 에 값이 필요함`);
    throw new AgentConfigError(msg);
  }
  if (values.help) return { help: true };
  const get = (o: (typeof OPTIONS)[number]): string | undefined => {
    const v = values[o.name];
    return typeof v === 'string' ? v : env[o.env];
  };
  const out: Record<string, string> = {};
  for (const o of OPTIONS) {
    const v = get(o);
    if (v === undefined || v === '') { if (o.required) throw new AgentConfigError(`--${o.name} 이 필요함 [${o.env}]`); continue; }
    out[o.key] = v;
  }
  try { new URL(out.controlPlane!); } catch { throw new AgentConfigError(`--control-plane 은 URL 이어야 함: ${out.controlPlane}`); }
  const engine = out.engine ?? 'mobile';
  if (!(ENGINES as readonly string[]).includes(engine)) throw new AgentConfigError(`--engine 은 ${ENGINES.join('|')} 중 하나여야 함: ${engine}`);
  const { timeoutMs: timeoutText, ...rest } = out;
  if (timeoutText !== undefined && !/^\d+$/.test(timeoutText)) throw new AgentConfigError(`--timeout 은 양의 정수(ms)여야 함: ${timeoutText}`);
  return { ...rest, engine, ...(timeoutText !== undefined ? { timeoutMs: Number(timeoutText) } : {}) } as unknown as RunArgs;
}
