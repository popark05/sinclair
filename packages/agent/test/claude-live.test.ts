// opt-in: 실제 Claude API 로 FakeEngine 로그인 시나리오를 끝낸다. 키가 있고 SINCLAIR_AGENT_LIVE=1 일 때만 돈다(키만 있어서는 과금되지 않게).
//   SINCLAIR_AGENT_LIVE=1 ANTHROPIC_API_KEY=... npx vitest run packages/agent/test/claude-live.test.ts
// 사내망(SSL 인터셉션)에서는 NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem 을 함께 준다.
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { loginScenario } from '@sinclair/protocol/testing';
import { agentFromEnv, estimateTokens, judgeAssert, judgeExtract, renderLedger, renderObservation, runAct, DEFAULT_AGENT_MODEL, type StepExecutor } from '../src/index.ts';
import { LOGIN_SCREEN } from '@sinclair/protocol/testing';

const live = process.env.SINCLAIR_AGENT_LIVE === '1' && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

describe.skipIf(!live)('Claude 실행기 · 실제 모델(opt-in)', () => {
  it('FakeEngine 로그인 화면에서 아이디·비밀번호를 입력하고 로그인해 환영 화면을 본 뒤 done', async () => {
    const engine = loginScenario();
    const setup = agentFromEnv(process.env);
    // Ledger 추정과 실제 input 토큰 비교(02 의 사용량): 추정은 user 메시지만, 실제는 system·툴까지라 실제가 더 크다
    let estimated = 0;
    const measured: StepExecutor = { ...setup.executor, next: (req, s) => { estimated += renderLedger(req).estimatedTokens; return setup.executor.next(req, s); } };
    const r = await runAct(engine, '아이디 qa, 비밀번호 qa-pass 로 로그인해줘', { ...setup, executor: measured });
    console.log(JSON.stringify({ ledgerEstimate: estimated, actualInput: (r.usage?.inputTokens ?? 0) + (r.usage?.cacheReadTokens ?? 0) + (r.usage?.cacheWriteTokens ?? 0) }));
    // 증거: 호출 수·토큰(키·입력값은 싣지 않는다)
    console.log(JSON.stringify({ model: process.env.SINCLAIR_AGENT_MODEL ?? 'claude-sonnet-5-5', ok: r.ok, turns: r.turns, modelCalls: r.modelCalls, usage: r.usage, tools: r.history.map((h) => `${h.call?.name ?? '(없음)'}:${h.result}`), reason: r.reason }));
    expect(r.ok).toBe(true);
    expect((await engine.observe()).root.children?.[0]?.text).toBe('환영합니다');
    expect(r.modelCalls).toBeGreaterThanOrEqual(2);
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
    expect(r.usage?.outputTokens).toBeGreaterThan(0);
  }, 180_000);

  it('판정 동사: 로그인 화면은 참, 홈 화면이라는 문장은 거짓, 제목을 문자열로 추출, 비밀번호 칸 추출은 거부되거나 못 찾음', async () => {
    const { executor } = agentFromEnv(process.env);
    const engine = loginScenario();
    const yes = await judgeAssert(engine, '로그인 화면이다', { executor });
    const no = await judgeAssert(engine, '환영 문구가 보이는 홈 화면이다', { executor });
    const title = await judgeExtract(engine, '화면 제목', 'string', { executor });
    const secret = await judgeExtract(engine, '비밀번호 칸에 입력된 값', 'string', { executor }).catch((e: { code?: string }) => ({ ok: false, failure: e.code }));
    console.log(JSON.stringify({ yes: [yes.ok, yes.modelCalls, yes.usage], no: [no.ok, no.failure], title: [title.ok, title.value], secret }));
    expect(yes.ok).toBe(true);
    expect(no).toMatchObject({ ok: false, failure: 'false' });
    expect(title).toMatchObject({ ok: true, value: expect.stringMatching(/Sinclair 로그인/) });
    expect(secret.ok).toBe(false);
  }, 180_000);

  it('Ledger 의 토큰 추정은 실제(countTokens)보다 작지 않다 — 한글 문장·트리 문법', async () => {
    const client = new Anthropic();
    const model = process.env.SINCLAIR_AGENT_MODEL ?? DEFAULT_AGENT_MODEL;
    const samples = ['아이디 qa, 비밀번호로 로그인하고 설정에서 알림을 끈 뒤 홈으로 돌아와라. '.repeat(20), renderObservation(LOGIN_SCREEN).repeat(10)];
    for (const text of samples) {
      const { input_tokens } = await client.messages.countTokens({ model, messages: [{ role: 'user', content: text }] });
      console.log(JSON.stringify({ chars: text.length, estimate: estimateTokens(text), actual: input_tokens }));
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(input_tokens - 10); // 메시지 틀 몫(수 토큰)은 뺀다
    }
  }, 60_000);
});
