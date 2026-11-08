// 에이전트 루프: 관찰 → 실행기(모델)에 다음 툴 → 닫힌 검사 → 엔진 실행. 대본 실행기로 FakeEngine 로그인 시나리오를 돈다.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { EngineError } from '@sinclair/protocol';
import { runAct, scriptedExecutor, renderObservation, type ToolCall } from '../src/index.ts';

const login = () => new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
const script: ToolCall[] = [
  { name: 'type', input: { ref: '@e2', text: 'qa' } },
  { name: 'type', input: { ref: '@e3', text: 'qa-pass' } }, // 비밀번호 칸(secure): 관찰에는 값이 다시 나오지 않는다
  { name: 'tap', input: { ref: '@e4' } },
  { name: 'done', input: { summary: '"환영합니다" 가 보인다' } },
];

describe('renderObservation', () => {
  it('트리를 한 줄에 노드 하나로(@ref role "이름/글자"), secure 노드의 값은 빠진다', () => {
    const text = renderObservation(LOGIN_SCREEN);
    expect(text).toMatch(/@e4 button "로그인"/);
    expect(text).toMatch(/@e2 textbox/);
    expect(text).not.toMatch(/hunter2/); // 비밀번호 칸(secure)의 값
    expect(text).toMatch(/@e3 textbox .*secure/);
  });
});

describe('runAct', () => {
  it('대본대로 입력 → 탭 → done 이면 성공하고, 실행기에 목표·관찰·지난 턴·툴 스키마를 준다', async () => {
    const engine = login();
    const exec = scriptedExecutor(script);
    const r = await runAct(engine, '아이디 qa 로 로그인해줘', { executor: exec });
    expect(r).toMatchObject({ ok: true, turns: 4, modelCalls: 4, summary: '"환영합니다" 가 보인다' });
    expect((await engine.observe()).root.children?.[0]?.text).toBe('환영합니다');
    const [first, , , third] = exec.requests;
    expect(first).toMatchObject({ goal: '아이디 qa 로 로그인해줘', history: [] });
    expect(first!.tools.map((t) => t.name)).toContain('tap');
    expect(first!.observation).toMatch(/@e4 button "로그인"/);
    expect(third!.observation).toMatch(/환영합니다/); // 실행 뒤 새 관찰
    expect(third!.history.map((h) => [h.call.name, h.result])).toEqual([['type', 'ok'], ['type', 'ok'], ['tap', 'ok']]);
    for (const req of exec.requests) expect(JSON.stringify(req)).not.toMatch(/hunter2/); // secure 값은 모델에 가지 않는다
  });

  it('닫힌 스키마를 어긴 호출은 실행하지 않고 다음 턴에 거부 사유를 돌려주며 턴에 센다', async () => {
    const engine = login();
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4', force: true } }, ...script]);
    const r = await runAct(engine, '로그인', { executor: exec });
    expect(r).toMatchObject({ ok: true, turns: 5 });
    expect(exec.requests[1]!.history[0]).toMatchObject({ result: 'rejected', detail: expect.stringMatching(/force/) });
    expect(engine.sessionCalls).toEqual([]); // 거부된 호출은 엔진에 닿지 않았다
  });

  it('엔진 오류(없는 ref)도 다음 턴에 알려 모델이 고칠 수 있다', async () => {
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@nope' } }, ...script]);
    const r = await runAct(login(), '로그인', { executor: exec });
    expect(r.ok).toBe(true);
    expect(exec.requests[1]!.history[0]).toMatchObject({ result: 'error', detail: expect.stringMatching(/not-found|없/) });
  });

  it('턴 한도·시간 한도에 닿으면 사유와 함께 실패한다', async () => {
    const loop = scriptedExecutor(() => ({ name: 'scroll', input: { ref: '@e0', direction: 'down' } }));
    const r = await runAct(login(), '끝나지 않는 목표', { executor: loop, maxTurns: 5 });
    expect(r).toMatchObject({ ok: false, turns: 5, modelCalls: 5, reason: expect.stringMatching(/턴 한도 5/) });
    const slow = scriptedExecutor(async () => { await new Promise((res) => setTimeout(res, 50)); return { name: 'scroll', input: { ref: '@e0', direction: 'down' } }; });
    const t = await runAct(login(), '느린 목표', { executor: slow, timeoutMs: 120 });
    expect(t).toMatchObject({ ok: false, reason: expect.stringMatching(/시간 한도 120ms/) });
  });

  it('실행기가 던지면(모델 오류) act 는 그 사유로 실패한다', async () => {
    const broken = scriptedExecutor(() => { throw new Error('모델 응답 없음'); });
    expect(await runAct(login(), '로그인', { executor: broken })).toMatchObject({ ok: false, reason: expect.stringMatching(/모델 응답 없음/) });
  });
});

describe('runAct · 견고함', () => {
  it('관찰하는 사이 시간 한도가 지나도, signal 을 무시하는 실행기에 매달리지 않는다', async () => {
    const engine = login();
    const observe = engine.observe.bind(engine);
    engine.observe = async (o) => { await new Promise((r) => setTimeout(r, 80)); return observe(o); };
    const never = scriptedExecutor(() => new Promise<ToolCall>(() => {})); // 영영 답하지 않고 signal 도 보지 않는다
    const started = Date.now();
    const r = await runAct(engine, '로그인', { executor: never, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/시간 한도 50ms/) });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('모델이 고칠 수 없는 엔진 오류(기기 없음·기기 오류)는 턴을 태우지 않고 그 코드로 던진다', async () => {
    const engine = login();
    engine.perform = async () => { throw new EngineError('device-unavailable', '기기 빠짐'); };
    const exec = scriptedExecutor(script);
    await expect(runAct(engine, '로그인', { executor: exec })).rejects.toMatchObject({ code: 'device-unavailable' });
    expect(exec.requests).toHaveLength(1);
  });

  it('모델에 돌려주는 엔진 오류 문구에서 이번에 입력한 글자를 지운다(실기기 셸 오류는 입력 명령을 그대로 싣는다)', async () => {
    const engine = login();
    const perform = engine.perform.bind(engine);
    let first = true;
    engine.perform = async (ref, action, arg) => {
      if (first && action === 'type') { first = false; throw new EngineError('not-actionable', `셸 명령 실패: input text '${arg}'`); }
      return perform(ref, action, arg);
    };
    const exec = scriptedExecutor([{ name: 'type', input: { ref: '@e2', text: 'secret-typed-value' } }, ...script]);
    await runAct(engine, '로그인', { executor: exec });
    const detail = exec.requests[1]!.history[0]!.detail!;
    expect(detail).toMatch(/<입력값>/);
    expect(JSON.stringify(exec.requests.slice(1))).not.toMatch(/secret-typed-value'/); // 오류 문구로는 되돌아가지 않는다(호출 기록 자체는 모델이 쓴 것)
  });
});
