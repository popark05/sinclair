// 비밀값: 모델은 자리표시({{secret:이름}})만 보고, type 의 text 에 온 자리표시만 실제 값으로 바뀌어 엔진에 간다. 값은 관찰·오류 문구에서도 가린다.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { EngineError } from '@sinclair/protocol';
import { runAct, judgeAssert, scriptedExecutor, SecretBox, secretPlaceholder, type StepExecutor, type ToolCall } from '../src/index.ts';

const VALUE = 'Tr0ub4dor&3';
const box = () => new SecretBox([['QA_PASSWORD', VALUE]]);
const P = secretPlaceholder('QA_PASSWORD');

/** 비밀번호 칸이 secure 가 아니라 입력한 값이 관찰에 그대로 보이는 화면 */
function plainLogin(): FakeEngine {
  const root: SemanticNode = structuredClone(LOGIN_SCREEN);
  root.children![2] = { ref: '@e3', role: 'textbox', placeholder: '비밀번호' };
  const engine = new FakeEngine({ root, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
  const perform = engine.perform.bind(engine);
  // 입력하면 그 값이 칸의 value 로 보인다(secure 아님)
  engine.perform = async (ref, action, arg) => { await perform(ref, action, arg); if (action === 'type' && ref === '@e3') { const r = structuredClone(root); r.children![2]!.value = arg ?? ''; engine.setRoot(r); } };
  return engine;
}
const script: ToolCall[] = [
  { name: 'type', input: { ref: '@e2', text: 'qa' } },
  { name: 'type', input: { ref: '@e3', text: P } },
  { name: 'tap', input: { ref: '@e4' } },
  { name: 'done', input: { summary: '로그인함' } },
];

describe('SecretBox', () => {
  it('자리표시를 값으로 바꾸고(모르는 이름은 오류), 값을 자리표시로 가린다', () => {
    const b = box();
    expect(b.reveal(`pw=${P}`)).toEqual({ ok: true, text: `pw=${VALUE}` });
    expect(b.reveal('{{secret:NOPE}}')).toMatchObject({ ok: false, error: expect.stringMatching(/NOPE/) });
    expect(b.redact(`셸 오류: input text '${VALUE}'`)).toBe(`셸 오류: input text '${P}'`);
    expect(b.mentions(`x ${P}`)).toBe(true);
    expect(() => new SecretBox([['lower', 'v']])).toThrow(/이름/);
  });
});

describe('runAct · 비밀값', () => {
  it('엔진에는 실제 값이 입력되고, 모델은 목표·관찰·지난 턴 어디서도 값을 보지 못한다(secure 가 아닌 칸이어도)', async () => {
    const engine = plainLogin();
    const exec = scriptedExecutor(script);
    const r = await runAct(engine, `아이디 qa, 비밀번호 ${P} 로 로그인`, { executor: exec, secrets: box() });
    expect(r.ok).toBe(true);
    expect(engine.performed).toContainEqual({ ref: '@e3', action: 'type', arg: VALUE });
    expect(exec.requests[2]!.observation).toMatch(new RegExp(`@e3 textbox .*${P.replace(/[{}]/g, '\\$&')}`)); // 칸에 보인 값은 자리표시로
    expect(JSON.stringify(exec.requests)).not.toContain(VALUE);
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it('자리표시를 type 의 text 밖(ref·done summary)에 쓰거나 모르는 이름이면 실행하지 않고 거부한다', async () => {
    const engine = plainLogin();
    const exec = scriptedExecutor([
      { name: 'tap', input: { ref: P } },
      { name: 'type', input: { ref: '@e3', text: '{{secret:OTHER}}' } },
      { name: 'done', input: { summary: `비밀번호는 ${P}` } },
      ...script,
    ]);
    const r = await runAct(engine, '로그인', { executor: exec, secrets: box() });
    expect(r.ok).toBe(true);
    expect(r.history.slice(0, 3).map((h) => h.result)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(r.history[1]!.detail).toMatch(/OTHER/);
    expect(engine.performed.filter((p) => p.ref === P)).toEqual([]);
  });

  it('엔진 오류 문구에 실린 실제 값을 가린다', async () => {
    const engine = plainLogin();
    let first = true;
    const perform = engine.perform.bind(engine);
    engine.perform = async (ref, action, arg) => { if (first && action === 'type' && ref === '@e3') { first = false; throw new EngineError('not-actionable', `셸 명령 실패: input text '${arg}'`); } return perform(ref, action, arg); };
    const exec = scriptedExecutor([script[1]!, ...script]);
    await runAct(engine, '로그인', { executor: exec, secrets: box() });
    expect(exec.requests[1]!.history[0]!.detail).toMatch(/<입력값>|secret:QA_PASSWORD/);
    expect(JSON.stringify(exec.requests)).not.toContain(VALUE);
  });

  it('비밀값이 있으면 이미지를 보는 실행기에도 픽셀을 보내지 않는다(픽셀은 가릴 수 없다)', async () => {
    const seen: unknown[] = [];
    const inner = scriptedExecutor(script);
    const visual: StepExecutor = { pixels: true, next: (req, s) => { seen.push(req.pixels); return inner.next(req, s); } };
    await runAct(plainLogin(), '로그인', { executor: visual, secrets: box() });
    expect(seen.every((p) => p === undefined)).toBe(true);
  });
});

describe('판정 동사 · 비밀값', () => {
  it('판정 요청의 관찰에서도 값을 가린다', async () => {
    const engine = plainLogin();
    await engine.perform('@e3', 'type', VALUE);
    const reqs: string[] = [];
    const exec: StepExecutor = { next: () => Promise.reject(new Error('x')), judge: async (req) => { reqs.push(JSON.stringify(req)); return { answer: { pass: true, reason: 'ok' } }; } };
    await judgeAssert(engine, '비밀번호가 입력됐다', { executor: exec, secrets: box() });
    expect(reqs[0]).toContain(P);
    expect(reqs[0]).not.toContain(VALUE);
  });
});
