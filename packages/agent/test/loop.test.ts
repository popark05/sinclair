// 에이전트 루프: 관찰 → 실행기(모델)에 다음 툴 → 닫힌 검사 → 엔진 실행. 대본 실행기로 FakeEngine 로그인 시나리오를 돈다.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { EngineError, type SemanticNode } from '@sinclair/protocol';
import { runAct, scriptedExecutor, renderObservation, ModelConfigError, actProgressOf, ModelCallError, type ToolCall, type StepExecutor } from '../src/index.ts';

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
    expect(third!.history.map((h) => [h.call?.name, h.result])).toEqual([['type', 'ok'], ['type', 'ok'], ['tap', 'ok']]);
    for (const req of exec.requests) expect(JSON.stringify(req)).not.toMatch(/hunter2/); // secure 값은 모델에 가지 않는다
  });

  it('검색어 입력 뒤 submit 으로 확정한다: 엔진에 Enter 가 눌리고 다음 턴 기록에 남는다(실행 키가 키보드에만 있는 화면)', async () => {
    const engine = login();
    const performed: string[] = [];
    const perform = engine.perform.bind(engine);
    engine.perform = async (ref, action, arg) => { performed.push(`${action} ${ref}${arg !== undefined ? ` ${arg}` : ''}`); return perform(ref, action, arg); };
    const exec = scriptedExecutor([{ name: 'type', input: { ref: '@e2', text: 'qa' } }, { name: 'submit', input: { ref: '@e2' } }, { name: 'done', input: { summary: '확정함' } }]);
    const r = await runAct(engine, '아이디를 입력하고 확정', { executor: exec });
    expect(r).toMatchObject({ ok: true, turns: 3 });
    expect(performed).toEqual(['type @e2 qa', 'press @e2 Enter']);
    expect(exec.requests[2]!.history.map((h) => [h.call?.name, h.result])).toEqual([['type', 'ok'], ['submit', 'ok']]);
  });

  it('onTurn 은 턴이 기록될 때마다 그 턴과 번호로 불린다(거부된 턴 포함, 순서대로) — Studio 세션 타임라인', async () => {
    const seen: Array<[number, string | undefined, string]> = [];
    const r = await runAct(login(), '로그인', { executor: scriptedExecutor([{ name: 'tap', input: { ref: '@e9' } }, ...script]), onTurn: (t, i) => seen.push([i, t.call?.name, t.result]) });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([[0, 'tap', 'rejected'], [1, 'type', 'ok'], [2, 'type', 'ok'], [3, 'tap', 'ok'], [4, 'done', 'ok']]);
  });

  it('onTurn 의 세 번째 인자는 그 턴에 모델이 본 화면 트리(대상 ref 를 그 화면에서 풀 수 있게)', async () => {
    const seen: Array<[number, string | undefined]> = [];
    await runAct(login(), '로그인', { executor: scriptedExecutor(script), onTurn: (t, i, observed) => seen.push([i, observed?.children?.find((c) => c.ref === (t.call?.input as { ref?: string } | undefined)?.ref)?.role]) });
    expect(seen.slice(0, 3)).toEqual([[0, 'textbox'], [1, 'textbox'], [2, 'button']]);
  });

  it('signal 을 abort 하면 곧바로 멈추고 사유는 중지됨(시간 한도가 아니다)', async () => {
    const ac = new AbortController();
    const slow: StepExecutor = { next: (_r, sig) => new Promise((_, rej) => sig.addEventListener('abort', () => rej(new Error('aborted')), { once: true })) };
    const p = runAct(login(), '로그인', { executor: slow, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: '중지됨' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('닫힌 스키마를 어긴 호출은 실행하지 않고 다음 턴에 거부 사유를 돌려주며 턴에 센다', async () => {
    const engine = login();
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4', force: true } }, ...script]);
    const r = await runAct(engine, '로그인', { executor: exec });
    expect(r).toMatchObject({ ok: true, turns: 5 });
    expect(exec.requests[1]!.history[0]).toMatchObject({ result: 'rejected', detail: expect.stringMatching(/force/) });
    expect(engine.sessionCalls).toEqual([]); // 거부된 호출은 엔진에 닿지 않았다
  });

  it('엔진 오류도 다음 턴에 알려 모델이 고칠 수 있다', async () => {
    const engine = login();
    const perform = engine.perform.bind(engine);
    let first = true;
    engine.perform = async (ref, a, arg) => { if (first) { first = false; throw new EngineError('not-actionable', '비활성'); } return perform(ref, a, arg); };
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, ...script]);
    const r = await runAct(engine, '로그인', { executor: exec });
    expect(r.ok).toBe(true);
    expect(exec.requests[1]!.history[0]).toMatchObject({ result: 'error', detail: expect.stringMatching(/not-actionable/) });
  });

  it('턴 한도·시간 한도에 닿으면 사유와 함께 실패한다', async () => {
    // 대상을 번갈아: 같은 호출이 화면을 바꾸지 않으면 진척 없음으로 먼저 멈춘다(incident-loop 가 다룬다)
    const loop = scriptedExecutor((_r, i) => ({ name: 'scroll', input: { ref: i % 2 ? '@e0' : '@e1', direction: 'down' } }));
    const r = await runAct(login(), '끝나지 않는 목표', { executor: loop, maxTurns: 5 });
    expect(r).toMatchObject({ ok: false, turns: 5, modelCalls: 5, reason: expect.stringMatching(/턴 한도 5/) });
    const slow = scriptedExecutor(async () => { await new Promise((res) => setTimeout(res, 50)); return { name: 'scroll', input: { ref: '@e0', direction: 'down' } }; }); // 시간 한도가 진척 없음(4턴)보다 먼저
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

describe('runAct · 모델 사용량과 설정', () => {
  it('실행기가 턴마다 돌려준 토큰 사용량을 act 결과에 더한다(캐시 필드는 보고된 것만)', async () => {
    const exec = scriptedExecutor(script.map((call, i) => ({ call, usage: { inputTokens: 100, outputTokens: 10, ...(i > 0 ? { cacheReadTokens: 900 } : {}) } })));
    const r = await runAct(login(), '로그인', { executor: exec });
    expect(r).toMatchObject({ ok: true, modelCalls: 4, usage: { inputTokens: 400, outputTokens: 40, cacheReadTokens: 2700 } });
    expect(r.usage).not.toHaveProperty('cacheWriteTokens');
  });

  it('사용량을 모르는 실행기(대본)면 usage 가 없다', async () => {
    expect(await runAct(login(), '로그인', { executor: scriptedExecutor(script) })).not.toHaveProperty('usage');
  });

  it('툴을 부르지 않은 턴은 거부로 기록해 다음 턴에 모델이 다시 고르게 한다', async () => {
    const exec = scriptedExecutor([{ text: '어떤 칸에 입력할까요?' }, ...script]);
    const r = await runAct(login(), '로그인', { executor: exec });
    expect(r).toMatchObject({ ok: true, turns: 5, modelCalls: 5 });
    expect(exec.requests[1]!.history[0]).toMatchObject({ result: 'rejected', detail: expect.stringMatching(/툴을 부르지 않음/) });
    expect(exec.requests[1]!.history[0]).not.toHaveProperty('call');
  });

  it('모델 호출 실패(거절 등)가 쓴 토큰도 결과에 남는다', async () => {
    const refused = scriptedExecutor(() => { throw new ModelCallError('모델이 거절함(general_harms)', { inputTokens: 50, outputTokens: 0 }); });
    expect(await runAct(login(), '로그인', { executor: refused })).toMatchObject({ ok: false, reason: expect.stringMatching(/거절/), usage: { inputTokens: 50, outputTokens: 0 } });
  });

  it('설정 오류(키 없음 등)는 실패 결과로 뭉개지 않고 그대로 던진다', async () => {
    const noKey = scriptedExecutor(() => { throw new ModelConfigError('ANTHROPIC_API_KEY 가 없음'); });
    await expect(runAct(login(), '로그인', { executor: noKey })).rejects.toBeInstanceOf(ModelConfigError);
  });

  it('화면 이미지는 실행기가 원할 때만 요청에 싣는다(기본: 트리만)', async () => {
    const plain = scriptedExecutor(script);
    await runAct(login(), '로그인', { executor: plain });
    expect(plain.requests[0]).not.toHaveProperty('pixels');
    const seen: Array<Uint8Array | undefined> = [];
    const inner = scriptedExecutor(script);
    const visual: StepExecutor = { pixels: true, next: (req, signal) => { seen.push(req.pixels); return inner.next(req, signal); } };
    await runAct(login(), '로그인', { executor: visual });
    expect(seen[0]?.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('runAct · 던질 때도 남는 사용량(리뷰 반영)', () => {
  it('루프가 던지면(기기 빠짐) 그때까지의 모델 호출 수·토큰을 오류에서 읽을 수 있다', async () => {
    const engine = login();
    const perform = engine.perform.bind(engine);
    let n = 0;
    engine.perform = async (ref, action, arg) => { if (++n === 2) throw new EngineError('device-unavailable', '기기 빠짐'); return perform(ref, action, arg); };
    const exec = scriptedExecutor(script.map((call) => ({ call, usage: { inputTokens: 100, outputTokens: 10 } })));
    const err = await runAct(engine, '로그인', { executor: exec }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'device-unavailable' });
    expect(actProgressOf(err)).toEqual({ modelCalls: 2, usage: { inputTokens: 200, outputTokens: 20 } });
    expect(actProgressOf(new Error('x'))).toBeUndefined();
  });
});

describe('runAct · 화면 변화(Ledger)', () => {
  it('실행 뒤 화면이 바뀐 부분이 그 턴의 기록에 붙는다(이전 관찰을 통째로 싣지 않는다)', async () => {
    const exec = scriptedExecutor(script);
    await runAct(login(), '로그인', { executor: exec });
    const tapTurn = exec.requests[3]!.history[2]!;
    expect(tapTurn).toMatchObject({ call: { name: 'tap' }, change: expect.stringMatching(/\+ "환영합니다".*− .*"로그인"/) });
    expect(exec.requests[1]!.history[0]).toMatchObject({ change: '없음' }); // 아이디 입력은 칸의 글자만 바뀌어 보이는 변화 없음 — "계산 안 함" 과 구별되게 '없음'
  });
});

describe('runAct · 화면 변화 · 리뷰 반영', () => {
  it('거부된 턴에는 변화를 붙이지 않고, Incident 복구를 거친 변화는 그렇다고 표시한다', async () => {
    const { APP, CRASH, LAUNCHER } = await import('./fixtures/incident-screens.ts');
    let crashed = false;
    const done: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@d', role: 'text', testId: 'com.shop:id/done', text: '완료' }] };
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' && !crashed ? ((crashed = true), CRASH) : n.ref === '@c2' ? LAUNCHER : n.ref === '@a2' ? done : undefined) });
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@a2', force: true } }, { name: 'tap', input: { ref: '@a2' } }, { name: 'done', input: { summary: 'x' } }]);
    await runAct(engine, '결제', { executor: exec });
    expect(exec.requests[1]!.history[0]).not.toHaveProperty('change');
    expect(exec.requests[2]!.history[1]!.change).toMatch(/Incident 복구 뒤/);
  });
});

describe('addUsage · 모델별', () => {
  it('합계와 모델별 내역을 함께 더한다(같은 모델은 합치고, 내역이 없는 쪽은 합계에만)', async () => {
    const { addUsage } = await import('../src/index.ts');
    const a = { inputTokens: 100, outputTokens: 10, byModel: { s: { inputTokens: 100, outputTokens: 10 } } };
    const b = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 7, byModel: { s: { inputTokens: 30, outputTokens: 3, cacheReadTokens: 7 }, h: { inputTokens: 20, outputTokens: 2 } } };
    expect(addUsage(a, b)).toEqual({ inputTokens: 150, outputTokens: 15, cacheReadTokens: 7, byModel: { s: { inputTokens: 130, outputTokens: 13, cacheReadTokens: 7 }, h: { inputTokens: 20, outputTokens: 2 } } });
    expect(addUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 })).not.toHaveProperty('byModel');
  });
});
