// 판정 동사: assert·waitFor·extract. 엔진 조작 없이 관찰만, 모델은 닫힌 답 스키마로만 답한다. 대본 judge 로 참·거짓·기한·타입·secure 를 본다.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { judgeAssert, judgeWaitFor, judgeExtract, ModelConfigError, scriptedExecutor, type JudgeRequest, type StepExecutor } from '../src/index.ts';

/** 대본 judge: 답 배열(다 쓰면 마지막을 되풀이) 또는 함수. 받은 요청을 남긴다 */
function judgeOnly(answers: unknown[] | ((req: JudgeRequest, i: number) => unknown), usage = { inputTokens: 100, outputTokens: 10 }): StepExecutor & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    next: () => Promise.reject(new Error('판정에서 next 를 부르면 안 된다')),
    async judge(req) {
      requests.push(structuredClone(req));
      const i = requests.length - 1;
      const answer = typeof answers === 'function' ? answers(req, i) : answers[Math.min(i, answers.length - 1)];
      return { answer, usage };
    },
  };
}

const CART: SemanticNode = { ref: '@c0', role: 'root', children: [
  { ref: '@c1', role: 'text', text: '합계 12,300원' },
  { ref: '@c2', role: 'textbox', name: '카드 비밀번호', value: '1234', states: { secure: true } },
] };

describe('judgeAssert', () => {
  it('참이면 통과하고 근거를 돌려준다. 엔진은 조작하지 않고 관찰만 하며 판정 요청에 secure 값이 없다', async () => {
    const engine = new FakeEngine({ root: LOGIN_SCREEN });
    const exec = judgeOnly([{ pass: true, reason: '로그인 버튼이 보인다' }]);
    const r = await judgeAssert(engine, '로그인 화면이다', { executor: exec });
    expect(r).toMatchObject({ ok: true, reason: '로그인 버튼이 보인다', modelCalls: 1, usage: { inputTokens: 100, outputTokens: 10 } });
    expect(engine.sessionCalls).toEqual([]);
    expect(exec.requests[0]).toMatchObject({ kind: 'assert', question: '로그인 화면이다' });
    expect(exec.requests[0]!.observation).toMatch(/@e4 button "로그인"/);
    expect(JSON.stringify(exec.requests[0])).not.toMatch(/hunter2/);
    expect(exec.requests[0]!.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['pass', 'reason'] });
  });

  it('거짓이면 판정 실패(false)이고 근거가 사유가 된다', async () => {
    const r = await judgeAssert(new FakeEngine({ root: LOGIN_SCREEN }), '홈 화면이다', { executor: judgeOnly([{ pass: false, reason: '아직 로그인 화면' }]) });
    expect(r).toMatchObject({ ok: false, failure: 'false', reason: '아직 로그인 화면' });
  });

  it('닫힌 스키마를 어긴 답(키 추가·타입 틀림)은 invalid', async () => {
    for (const bad of [{ pass: 'yes', reason: 'x' }, { pass: true, reason: 'x', extra: 1 }, { pass: true }, 'true']) {
      const r = await judgeAssert(new FakeEngine({ root: LOGIN_SCREEN }), '아무거나', { executor: judgeOnly([bad]) });
      expect(r).toMatchObject({ ok: false, failure: 'invalid' });
    }
  });

  it('실행기에 judge 가 없으면 설정 오류로 던진다', async () => {
    await expect(judgeAssert(new FakeEngine({ root: LOGIN_SCREEN }), 'x', { executor: scriptedExecutor([]) })).rejects.toBeInstanceOf(ModelConfigError);
  });
});

describe('judgeWaitFor', () => {
  it('화면이 바뀌어 참이 될 때까지 다시 보고, 화면이 그대로인 동안은 모델을 다시 부르지 않는다', async () => {
    const engine = new FakeEngine({ root: LOGIN_SCREEN });
    let observes = 0;
    const observe = engine.observe.bind(engine);
    engine.observe = async (o) => { if (++observes === 4) engine.setRoot(HOME_SCREEN); return observe(o); };
    const exec = judgeOnly((req) => (/환영합니다/.test(req.observation) ? { pass: true, reason: '환영 문구' } : { pass: false, reason: '아직' }));
    const r = await judgeWaitFor(engine, '환영 문구가 뜬다', { executor: exec, timeoutMs: 2000, intervalMs: 10 });
    expect(r).toMatchObject({ ok: true, modelCalls: 2 }); // 같은 로그인 화면 세 번은 한 번만 물었다
    expect(observes).toBeGreaterThanOrEqual(4);
  });

  it('기한 안에 참이 되지 않으면 timeout 이고 마지막 근거가 사유에 남는다', async () => {
    const r = await judgeWaitFor(new FakeEngine({ root: LOGIN_SCREEN }), '홈 화면', { executor: judgeOnly([{ pass: false, reason: '로그인 화면 그대로' }]), timeoutMs: 100, intervalMs: 10 });
    expect(r).toMatchObject({ ok: false, failure: 'timeout', modelCalls: 1, reason: expect.stringMatching(/100ms.*로그인 화면 그대로/) });
  });

  it('응답하지 않는 judge 에 기한을 넘겨 매달리지 않는다', async () => {
    const hang: StepExecutor = { next: () => new Promise(() => {}), judge: () => new Promise(() => {}) };
    const started = Date.now();
    expect(await judgeWaitFor(new FakeEngine({ root: LOGIN_SCREEN }), 'x', { executor: hang, timeoutMs: 80, intervalMs: 10 })).toMatchObject({ ok: false, failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('judgeExtract', () => {
  it('요청한 타입(숫자·객체)의 값을 돌려주고 답 스키마가 그 타입을 담는다', async () => {
    const exec = judgeOnly([{ found: true, value: 12300, sourceRefs: ['@c1'], reason: '합계 문구' }]);
    const r = await judgeExtract(new FakeEngine({ root: CART }), '장바구니 합계', 'number', { executor: exec });
    expect(r).toMatchObject({ ok: true, value: 12300 });
    expect(exec.requests[0]!.schema).toMatchObject({ properties: { value: { type: 'number' } } });
    const obj = await judgeExtract(new FakeEngine({ root: CART }), '합계와 통화', { amount: 'number', currency: 'string' }, { executor: judgeOnly([{ found: true, value: { amount: 12300, currency: 'KRW' }, sourceRefs: ['@c1'], reason: 'x' }]) });
    expect(obj).toMatchObject({ ok: true, value: { amount: 12300, currency: 'KRW' } });
  });

  it('타입이 안 맞거나 근거 ref 가 화면에 없거나 비면 invalid, 못 찾으면 not-found', async () => {
    const run = (answer: unknown) => judgeExtract(new FakeEngine({ root: CART }), '합계', 'number', { executor: judgeOnly([answer]) });
    expect(await run({ found: true, value: '12,300', sourceRefs: ['@c1'], reason: 'x' })).toMatchObject({ ok: false, failure: 'invalid' });
    expect(await run({ found: true, value: 12300, sourceRefs: ['@zz'], reason: 'x' })).toMatchObject({ ok: false, failure: 'invalid', reason: expect.stringMatching(/@zz/) });
    expect(await run({ found: true, value: 12300, sourceRefs: [], reason: 'x' })).toMatchObject({ ok: false, failure: 'invalid' });
    expect(await run({ found: false, value: 0, sourceRefs: [], reason: '합계가 없다' })).toMatchObject({ ok: false, failure: 'not-found', reason: '합계가 없다' });
  });

  it('근거가 secure 노드면 secure-read 로 거부한다(값을 돌려주지 않는다)', async () => {
    const exec = judgeOnly([{ found: true, value: '1234', sourceRefs: ['@c2'], reason: '비밀번호 칸' }]);
    await expect(judgeExtract(new FakeEngine({ root: CART }), '카드 비밀번호', 'string', { executor: exec })).rejects.toMatchObject({ code: 'secure-read' });
    expect(JSON.stringify(exec.requests[0])).not.toMatch(/1234/); // 관찰에도 값은 없었다
  });
});
