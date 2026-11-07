// 서버 설정: 플래그 > 환경변수 > 기본값. 순수 함수라 테이블 테스트가 쉽다.
import * as path from 'node:path';

export interface ControlPlaneConfig {
  host: string;
  port: number;
  store: 'memory' | 'sqlite';
  /** sqlite 모드의 DB 파일. memory 모드에서는 무시된다 */
  db: string;
}

export class ConfigError extends Error {}

/** 4780: 등록된 서비스와 겹치지 않는 임의의 높은 포트. 8080/3000 계열은 로컬 개발 서버와 자주 충돌한다 */
const DEFAULT_PORT = 4780;
const STORES = ['memory', 'sqlite'] as const;

export const HELP = `사용법: sinclair-control-plane [옵션]

  --host <addr>            바인딩 주소 (기본 127.0.0.1, 환경변수 SINCLAIR_CP_HOST)
  --port <n>               포트 (기본 ${DEFAULT_PORT}, 0 이면 OS 배정, SINCLAIR_CP_PORT)
  --store memory|sqlite    저장소 (기본 sqlite, SINCLAIR_CP_STORE)
  --db <path>              SQLite 파일 (기본 OS 데이터 디렉터리/sinclair/control-plane.db, SINCLAIR_CP_DB)
  --help                   이 도움말
`;

/** OS 관례의 사용자 데이터 디렉터리 아래 sinclair/ */
export function defaultDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'sinclair');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'sinclair');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'sinclair');
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ControlPlaneConfig | { help: true } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new ConfigError(`모르는 인자: ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!['host', 'port', 'store', 'db'].includes(name)) throw new ConfigError(`모르는 옵션: --${name}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new ConfigError(`--${name} 에 값이 필요함`);
    flags[name] = value;
  }
  const pick = (name: string, envName: string, fallback: string): string => flags[name] ?? env[envName] ?? fallback;

  const host = pick('host', 'SINCLAIR_CP_HOST', '127.0.0.1');
  if (!host) throw new ConfigError('host 가 비어 있음');
  const portText = pick('port', 'SINCLAIR_CP_PORT', String(DEFAULT_PORT));
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new ConfigError(`port 는 0~65535 의 정수여야 함: ${portText}`);
  const store = pick('store', 'SINCLAIR_CP_STORE', 'sqlite');
  if (!(STORES as readonly string[]).includes(store)) throw new ConfigError(`store 는 ${STORES.join('|')} 중 하나여야 함: ${store}`);
  const db = pick('db', 'SINCLAIR_CP_DB', path.join(defaultDataDir(env, platform), 'control-plane.db'));
  if (!db) throw new ConfigError('db 경로가 비어 있음');
  return { host, port, store: store as ControlPlaneConfig['store'], db };
}
