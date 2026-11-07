// parseRunArgs: 플래그 > 환경변수 > 기본값, 필수값 누락과 잘못된 값은 AgentConfigError.
import { describe, it, expect } from 'vitest';
import { parseRunArgs, AgentConfigError } from '../src/index.ts';

const required = ['--control-plane', 'http://127.0.0.1:4780', '--cycle', 'c1', '--target', 'android', '--tests', './tests'];

describe('parseRunArgs', () => {
  it('필수값과 기본값', () => {
    expect(parseRunArgs(required, {})).toEqual({ controlPlane: 'http://127.0.0.1:4780', cycle: 'c1', target: 'android', tests: './tests', engine: 'mobile' });
  });

  it('환경변수가 기본값을 덮고 플래그가 환경변수를 덮는다', () => {
    const env = { SINCLAIR_AGENT_CONTROL_PLANE: 'http://cp:1', SINCLAIR_AGENT_ENGINE: 'fake', SINCLAIR_AGENT_DEVICE: 'SER', SINCLAIR_AGENT_APP: 'com.x' };
    expect(parseRunArgs(['--cycle', 'c1', '--target', 't', '--tests', 'd'], env)).toEqual({ controlPlane: 'http://cp:1', cycle: 'c1', target: 't', tests: 'd', engine: 'fake', device: 'SER', app: 'com.x' });
    expect(parseRunArgs([...required, '--engine', 'mobile', '--run', 'r9', '--artifacts', '/tmp/a', '--timeout', '500', '--agent', 'node-1'], env)).toMatchObject({ engine: 'mobile', run: 'r9', artifacts: '/tmp/a', timeoutMs: 500, agent: 'node-1', controlPlane: 'http://127.0.0.1:4780' });
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
