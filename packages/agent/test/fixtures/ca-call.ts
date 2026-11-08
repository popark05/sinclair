// 자식 프로세스: NODE_EXTRA_CA_CERTS 는 프로세스 시작 때만 읽히므로 별도 Node 로 실제 실행기를 한 번 돌린다. 결과 JSON 한 줄을 낸다
import { loginScenario } from '@sinclair/protocol/testing/login-scenario';
import { createClaudeExecutor, runAct } from '../../src/index.ts';

const r = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor({ apiKey: 'sk-ant-ca-test', baseURL: process.env.CA_TEST_BASE_URL!, maxRetries: 0 }), maxTurns: 1 });
console.log(JSON.stringify({ ok: r.ok, reason: r.reason }));
