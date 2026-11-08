// 서버 설정: 플래그 > 환경변수 > 기본값. 순수 함수라 테이블 테스트가 쉽다.
import * as path from 'node:path';
import { parseArgs } from 'node:util';

export interface ControlPlaneConfig {
  host: string;
  port: number;
  store: 'memory' | 'sqlite';
  /** sqlite 모드의 DB 파일. memory 모드에서는 무시된다 */
  db: string;
  /** 클레임 lease 수명(ms). 버려진 Run 판정 유예도 이 값이다. 없으면 서버 기본(60초) */
  leaseTtlMs?: number;
}

export class ConfigError extends Error {}

/** 4780: 등록된 서비스와 겹치지 않는 임의의 높은 포트. 8080/3000 계열은 로컬 개발 서버와 자주 충돌한다 */
const DEFAULT_PORT = 4780;
const STORES = ['memory', 'sqlite'] as const;
const DEFAULT_LEASE_TTL_MS = 60_000;

/** 옵션 표 하나가 파서와 도움말을 모두 만든다. env 는 같은 이름의 환경변수 */
const OPTIONS = [
  { name: 'host', env: 'SINCLAIR_CP_HOST', help: '바인딩 주소 (기본 127.0.0.1). 인증이 없으므로 0.0.0.0 등 외부 노출은 신뢰망 안에서만' },
  { name: 'port', env: 'SINCLAIR_CP_PORT', help: `포트 (기본 ${DEFAULT_PORT}, 0 이면 OS 배정)` },
  { name: 'store', env: 'SINCLAIR_CP_STORE', help: '저장소 memory|sqlite (기본 sqlite)' },
  { name: 'db', env: 'SINCLAIR_CP_DB', help: 'SQLite 파일 (기본 OS 데이터 디렉터리/sinclair/control-plane.db)' },
  { name: 'lease-ttl-ms', env: 'SINCLAIR_CP_LEASE_TTL_MS', help: `클레임 lease 수명 ms (기본 ${DEFAULT_LEASE_TTL_MS}). 버려진 Run 판정 유예도 같은 값` },
] as const;

export const HELP = `사용법: sinclair-control-plane [옵션]

${OPTIONS.map((o) => `  --${o.name.padEnd(12)} <값>   ${o.help} [${o.env}]`).join('\n')}
  --help               이 도움말

기동하면 "READY http://<host>:<port> port=<port> store=<memory|sqlite db=<경로> schema=<n>> pid=<pid>" 한 줄을 찍는다(스크립트가 파싱하는 계약).
SIGTERM/SIGINT 에 연결과 DB 를 닫고 끝난다. 두 번째 신호는 즉시 종료한다.
`;

/** OS 관례의 사용자 데이터 디렉터리 아래 sinclair/ */
export function defaultDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'sinclair');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'sinclair');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'sinclair');
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ControlPlaneConfig | { help: true } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { ...Object.fromEntries(OPTIONS.map((o) => [o.name, { type: 'string' as const }])), help: { type: 'boolean' as const, short: 'h' } },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unknown option/.test(msg)) throw new ConfigError(`모르는 옵션: ${msg.match(/'(--?[^']+)'/)?.[1] ?? msg}`);
    if (/argument missing/.test(msg)) throw new ConfigError(`${msg.match(/'(--?[^']+)'/)?.[1] ?? '옵션'} 에 값이 필요함`);
    if (/positional/i.test(msg)) throw new ConfigError(`모르는 인자: ${msg.match(/'([^']+)'/)?.[1] ?? msg}`);
    throw new ConfigError(msg);
  }
  if (values.help) return { help: true };
  const resolve = (name: (typeof OPTIONS)[number]['name'], fallback: string): string => {
    const flag = values[name];
    if (typeof flag === 'string') return flag;
    const fromEnv = env[OPTIONS.find((o) => o.name === name)!.env];
    return fromEnv ? fromEnv : fallback; // 빈 환경변수는 미설정으로 본다(runner-agent 와 같은 규칙)
  };

  const host = resolve('host', '127.0.0.1');
  if (!host) throw new ConfigError('host 가 비어 있음');
  const portText = resolve('port', String(DEFAULT_PORT));
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new ConfigError(`port 는 0~65535 의 정수여야 함: ${portText}`);
  const store = resolve('store', 'sqlite');
  if (!(STORES as readonly string[]).includes(store)) throw new ConfigError(`store 는 ${STORES.join('|')} 중 하나여야 함: ${store}`);
  const db = resolve('db', path.join(defaultDataDir(env, platform), 'control-plane.db'));
  if (!db) throw new ConfigError('db 경로가 비어 있음');
  const ttlText = resolve('lease-ttl-ms', String(DEFAULT_LEASE_TTL_MS));
  const leaseTtlMs = Number(ttlText);
  if (!/^\d+$/.test(ttlText) || leaseTtlMs < 1000) throw new ConfigError(`lease-ttl-ms 는 1000 이상의 정수여야 함: ${ttlText}`);
  return { host, port, store: store as ControlPlaneConfig['store'], db, leaseTtlMs };
}
