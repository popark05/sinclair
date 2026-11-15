// 설치본 환경(studio-packaging 01): Finder 로 띄운 앱은 셸 환경변수가 없다 — ~/.config/sinclair/env 의 허용한 이름만 작업 프로세스에 싣는다.
import { describe, it, expect } from 'vitest';
import { parseEnvFile, workerEnv, ENV_FILE_DEFAULT } from '../src/main/env-file.ts';

describe('parseEnvFile', () => {
  it('KEY=VALUE·export·따옴표·주석·빈 줄, 허용한 이름(ANTHROPIC_*·SINCLAIR_*·NODE_EXTRA_CA_CERTS)만', () => {
    const text = [
      '# 주석', '', 'export ANTHROPIC_API_KEY=sk-test', "SINCLAIR_AGENT_MODEL='claude-sonnet-5-5'", 'NODE_EXTRA_CA_CERTS="/Users/qa/certs.pem"',
      'PATH=/evil', 'DYLD_INSERT_LIBRARIES=/x.dylib', 'NODE_OPTIONS=--require /x.js', 'export SINCLAIR_SECRET_PIN=123456  ', 'not a line',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({ ANTHROPIC_API_KEY: 'sk-test', SINCLAIR_AGENT_MODEL: 'claude-sonnet-5-5', NODE_EXTRA_CA_CERTS: '/Users/qa/certs.pem', SINCLAIR_SECRET_PIN: '123456' });
  });

  it('프로세스 환경이 파일보다 우선하고, 파일이 없으면 프로세스 환경 그대로', () => {
    expect(workerEnv({ ANTHROPIC_API_KEY: 'from-shell', HOME: '/h' }, 'ANTHROPIC_API_KEY=from-file\nSINCLAIR_AGENT_MODEL=m')).toEqual({ ANTHROPIC_API_KEY: 'from-shell', HOME: '/h', SINCLAIR_AGENT_MODEL: 'm' });
    expect(workerEnv({ HOME: '/h' }, undefined)).toEqual({ HOME: '/h' });
    expect(ENV_FILE_DEFAULT('/Users/qa')).toBe('/Users/qa/.config/sinclair/env');
  });
});
