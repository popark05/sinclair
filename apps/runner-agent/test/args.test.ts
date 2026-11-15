// parseRunArgs: 플래그 > 환경변수 > 기본값, 필수값 누락과 잘못된 값은 AgentConfigError.
import { describe, it, expect } from 'vitest';
import { MAX_RETRIES as RUNNER_MAX_RETRIES, CANCELLED_CODE as RUNNER_CANCELLED } from '@sinclair/runner';
import { MAX_SUITE_RETRIES, CANCELLED_CODE as CP_CANCELLED } from '@sinclair/control-plane';
import { parseRunArgs, parseResumeArgs, AgentConfigError, MAX_RETRIES } from '../src/index.ts';
import type { RunArgs } from '../src/args.ts';

const required = ['--control-plane', 'http://127.0.0.1:4780', '--cycle', 'c1', '--target', 'android', '--tests', './tests'];

describe('parseRunArgs', () => {
  it('재시도 상한은 러너·control-plane·runner-agent 가 같은 숫자다(apps 가 러너를 import 하지 않아 상수를 따로 둔다)', () => {
    expect([MAX_RETRIES, MAX_SUITE_RETRIES]).toEqual([RUNNER_MAX_RETRIES, RUNNER_MAX_RETRIES]);
    expect(CP_CANCELLED).toBe(RUNNER_CANCELLED); // 취소 skipped 의 errorCode: 러너가 쓰고 Verdict 가 읽는다
  });

  it('필수값과 기본값', () => {
    expect(parseRunArgs(required, { HOME: '/home/qa' }, 'linux')).toEqual({ controlPlane: 'http://127.0.0.1:4780', cycle: 'c1', target: 'android', tests: './tests', engine: 'mobile', cache: 'read-write', spool: '/home/qa/.local/share/sinclair/spool', helperCache: '/home/qa/.local/share/sinclair/cache/helper' });
  });

  it('환경변수가 기본값을 덮고 플래그가 환경변수를 덮는다', () => {
    const env = { SINCLAIR_AGENT_CONTROL_PLANE: 'http://cp:1', SINCLAIR_AGENT_ENGINE: 'fake', SINCLAIR_AGENT_DEVICE: 'SER', SINCLAIR_AGENT_APP: 'com.x' };
    expect(parseRunArgs(['--cycle', 'c1', '--target', 't', '--tests', 'd', '--spool', '/s', '--helper-apk', '/h.apk', '--helper-cache', '/hc'], env)).toEqual({ controlPlane: 'http://cp:1', cycle: 'c1', target: 't', tests: 'd', engine: 'fake', cache: 'read-write', device: 'SER', app: 'com.x', spool: '/s', helperApk: '/h.apk', helperCache: '/hc' });
    expect(parseRunArgs([...required, '--engine', 'mobile', '--run', 'r9', '--artifacts', '/tmp/a', '--timeout', '500', '--retries', '2', '--agent', 'node-1'], env)).toMatchObject({ engine: 'mobile', run: 'r9', artifacts: '/tmp/a', timeoutMs: 500, retries: 2, agent: 'node-1', controlPlane: 'http://127.0.0.1:4780' });
    expect(parseRunArgs([...required], { ...env, SINCLAIR_AGENT_RETRIES: '1' })).toMatchObject({ retries: 1 });
    expect(() => parseRunArgs([...required, '--retries', '6'], env)).toThrow(/retries/);
    expect(() => parseRunArgs([...required, '--retries', '-1'], env)).toThrow(AgentConfigError);
  });

  it.each([
    [['--cycle', 'c1', '--target', 't', '--tests', 'd'], /control-plane/],
    [[...required, '--control-plane', 'not a url'], /control-plane.*URL/],
    [[...required, '--engine', 'web'], /engine/],
    [[...required, '--bogus'], /모르는 옵션/],
    [[...required, '--timeout', 'fast'], /timeout/],
    [['--control-plane', 'http://x', '--target', 't', '--tests', 'd'], /cycle/],
  ])('잘못된 인자 %j', (argv, pattern) => {
    expect(() => parseRunArgs([...argv], {})).toThrow(AgentConfigError);
    expect(() => parseRunArgs([...argv], {})).toThrow(pattern);
  });

  it('--help', () => {
    expect(parseRunArgs(['--help'], {})).toEqual({ help: true });
  });
});

describe('parseResumeArgs', () => {
  it('기본 스풀 디렉터리, 플래그·환경변수, 잘못된 URL', () => {
    expect(parseResumeArgs([], { HOME: '/h' }, 'darwin')).toEqual({ spool: '/h/Library/Application Support/sinclair/spool' });
    expect(parseResumeArgs(['--spool', '/s', '--control-plane', 'http://cp:1'], {})).toEqual({ spool: '/s', controlPlane: 'http://cp:1' });
    expect(parseResumeArgs([], { SINCLAIR_AGENT_SPOOL: '/e', SINCLAIR_AGENT_CONTROL_PLANE: 'http://e:2' })).toEqual({ spool: '/e', controlPlane: 'http://e:2' });
    expect(() => parseResumeArgs(['--control-plane', 'nope'], {})).toThrow(AgentConfigError);
    expect(parseResumeArgs(['--help'], {})).toEqual({ help: true });
  });
});

describe('플랫폼별 앱(ios-backend 05)', () => {
  it('--ios-app·SINCLAIR_AGENT_IOS_APP 는 iOS 기기의 세션 앱, --app 은 Android 기기의 것 — iOS 기기에 Android 앱 id 를 쓰지 않는다', async () => {
    const { withPlatformApp } = await import('../src/engines.ts');
    const a = parseRunArgs(['--control-plane', 'http://x', '--cycle', 'c', '--target', 't', '--tests', 'd', '--app', 'com.google.android.youtube', '--ios-app', 'com.apple.Preferences'], {}, 'linux') as RunArgs;
    expect(a.iosApp).toBe('com.apple.Preferences');
    expect((parseRunArgs(['--control-plane', 'http://x', '--cycle', 'c', '--target', 't', '--tests', 'd'], { SINCLAIR_AGENT_IOS_APP: 'com.x.ios' }, 'linux') as RunArgs).iosApp).toBe('com.x.ios');
    expect(withPlatformApp(a, 'android').app).toBe('com.google.android.youtube');
    expect(withPlatformApp(a, 'ios').app).toBe('com.apple.Preferences');
    const { iosApp: _i, ...withoutIos } = a;
    const noIos = withPlatformApp(withoutIos, 'ios');
    expect('app' in noIos).toBe(false);
  });
});
