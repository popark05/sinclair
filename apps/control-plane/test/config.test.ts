// parseConfig: 플래그 > 환경변수 > 기본값. 잘못된 값은 ConfigError 로 한국어 메시지.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseConfig, ConfigError, defaultDataDir } from '../src/index.ts';

const env = (o: Record<string, string> = {}) => ({ HOME: '/home/qa', ...o });

describe('parseConfig', () => {
  it('기본값: 127.0.0.1:4780, sqlite, OS 데이터 디렉터리의 control-plane.db', () => {
    const c = parseConfig([], env(), 'linux');
    expect(c).toEqual({ host: '127.0.0.1', port: 4780, store: 'sqlite', db: path.join('/home/qa/.local/share/sinclair', 'control-plane.db'), leaseTtlMs: 60_000, artifactsDir: path.resolve('/home/qa/.local/share/sinclair', 'artifacts') });
  });

  it.each([
    ['darwin', {}, '/home/qa/Library/Application Support/sinclair'],
    ['win32', { APPDATA: 'C:\\Users\\qa\\AppData\\Roaming' }, path.join('C:\\Users\\qa\\AppData\\Roaming', 'sinclair')],
    ['linux', { XDG_DATA_HOME: '/data' }, '/data/sinclair'],
  ] as const)('데이터 디렉터리는 OS 관례를 따른다: %s', (platform, extra, expected) => {
    expect(defaultDataDir(env(extra), platform)).toBe(expected);
  });

  it('환경변수가 기본값을 덮고 플래그가 환경변수를 덮는다', () => {
    const e = env({ SINCLAIR_CP_PORT: '5000', SINCLAIR_CP_HOST: '0.0.0.0', SINCLAIR_CP_STORE: 'memory', SINCLAIR_CP_DB: '/tmp/x.db' });
    expect(parseConfig([], e, 'linux')).toEqual({ host: '0.0.0.0', port: 5000, store: 'memory', db: '/tmp/x.db', leaseTtlMs: 60_000 });
    expect(parseConfig(['--port', '0', '--host', '127.0.0.1', '--store', 'sqlite', '--db', '/tmp/y.db'], e, 'linux')).toEqual({ host: '127.0.0.1', port: 0, store: 'sqlite', db: '/tmp/y.db', leaseTtlMs: 60_000, artifactsDir: path.resolve(path.join(e.HOME ?? '', '.local', 'share', 'sinclair', 'artifacts')) });
    expect(parseConfig(['--port=6000'], e, 'linux')).toMatchObject({ port: 6000 }); // = 형식도 받는다
  });

  it.each([
    [['--port', 'abc'], /port/],
    [['--port', '70000'], /port/],
    [['--store', 'postgres'], /store/],
    [['--db', ''], /db/],
    [['--bogus'], /모르는 옵션/],
    [['--port'], /port.*값/],
    [['extra'], /모르는 인자/],
  ])('잘못된 값 %j 은 ConfigError', (argv, pattern) => {
    expect(() => parseConfig([...argv], env(), 'linux')).toThrow(ConfigError);
    expect(() => parseConfig([...argv], env(), 'linux')).toThrow(pattern);
  });

  it('--help 는 도움말 요청으로 표시된다', () => {
    expect(parseConfig(['--help'], env(), 'linux')).toEqual({ help: true });
  });
});

describe('parseConfig lease-ttl-ms', () => {
  it('--lease-ttl-ms / SINCLAIR_CP_LEASE_TTL_MS 로 lease 수명을 정하고 1000 미만·정수 아님은 거부한다', () => {
    expect(parseConfig(['--lease-ttl-ms', '5000'], {}, 'linux')).toMatchObject({ leaseTtlMs: 5000 });
    expect(parseConfig([], { SINCLAIR_CP_LEASE_TTL_MS: '3000' }, 'linux')).toMatchObject({ leaseTtlMs: 3000 });
    expect(() => parseConfig(['--lease-ttl-ms', '999'], {}, 'linux')).toThrow(/lease-ttl-ms/);
    expect(() => parseConfig(['--lease-ttl-ms', '1.5s'], {}, 'linux')).toThrow(/lease-ttl-ms/);
  });
});
