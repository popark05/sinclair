// opt-in: 실제 Claude API 로 FakeEngine 로그인 시나리오를 끝낸다. 키가 있고 SINCLAIR_AGENT_LIVE=1 일 때만 돈다(키만 있어서는 과금되지 않게).
//   SINCLAIR_AGENT_LIVE=1 ANTHROPIC_API_KEY=... npx vitest run packages/agent/test/claude-live.test.ts
// 사내망(SSL 인터셉션)에서는 NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem 을 함께 준다.
import { describe, expect, it } from 'vitest';
import { loginScenario } from '@sinclair/protocol/testing';
import { agentFromEnv, runAct } from '../src/index.ts';

const live = process.env.SINCLAIR_AGENT_LIVE === '1' && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

describe.skipIf(!live)('Claude 실행기 · 실제 모델(opt-in)', () => {
  it('FakeEngine 로그인 화면에서 아이디·비밀번호를 입력하고 로그인해 환영 화면을 본 뒤 done', async () => {
    const engine = loginScenario();
    const setup = agentFromEnv(process.env);
    const r = await runAct(engine, '아이디 qa, 비밀번호 qa-pass 로 로그인해줘', setup);
    // 증거: 호출 수·토큰(키·입력값은 싣지 않는다)
    console.log(JSON.stringify({ model: process.env.SINCLAIR_AGENT_MODEL ?? 'claude-sonnet-5-5', ok: r.ok, turns: r.turns, modelCalls: r.modelCalls, usage: r.usage, tools: r.history.map((h) => `${h.call?.name ?? '(없음)'}:${h.result}`), reason: r.reason }));
    expect(r.ok).toBe(true);
    expect((await engine.observe()).root.children?.[0]?.text).toBe('환영합니다');
    expect(r.modelCalls).toBeGreaterThanOrEqual(2);
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
    expect(r.usage?.outputTokens).toBeGreaterThan(0);
  }, 180_000);
});
