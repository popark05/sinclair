// 앱 중간 비밀값(agent-secrets 01): blocked 로 멈추기, enter_secret 으로 입력칸·키패드(섞이는 보안 키패드)에 넣기, 녹화·재생, 반복 고리.
// 실기 Studio 세션에서 간편비밀번호 화면에 막혀 20턴을 헛돌았다(2026-11-14).
import { describe, it, expect } from 'vitest';
import { FakeEngine } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { runAct, scriptedExecutor, replayRecording, SecretBox, type ToolCall } from '../src/index.ts';

/** 숫자 키패드 화면. order 로 키 배치를 섞는다(보안 키패드). 입력한 자리 수만큼 ● */
const keypad = (order: string, entered: number): SemanticNode => ({
  ref: '@r', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
    { ref: '@t', role: 'text', text: '간편비밀번호 4자리', rect: { x: 0, y: 200, width: 1080, height: 80 } },
    { ref: '@dots', role: 'text', text: '●'.repeat(entered) || '○○○○', rect: { x: 0, y: 400, width: 1080, height: 80 } },
    { ref: '@pad', role: 'group', rect: { x: 0, y: 1400, width: 1080, height: 900 }, children: [...order].map((d, i) => ({ ref: `@k${i}`, role: 'button', name: d, rect: { x: (i % 3) * 360, y: 1400 + Math.floor(i / 3) * 225, width: 360, height: 225 } })) },
  ],
});
const DONE: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@ok', role: 'text', text: '문 열림 전송 완료' }] };

/** 키를 누를 때마다 배치가 바뀌는 키패드. 네 자리를 다 누르면 그 값이 PIN 이면 완료 화면 */
function pinEngine(pin: string, first = '1234567890') {
  const orders = [first, '9081726354', '5647382910', '0192837465', '1234567890'];
  let typed = '';
  const engine: FakeEngine = new FakeEngine({ root: keypad(orders[0]!, 0), onTap: (n) => {
    if (n.role !== 'button' || !n.name) return undefined;
    typed += n.name;
    if (typed.length === 4) return typed === pin ? DONE : keypad(orders[0]!, 0);
    return keypad(orders[typed.length]!, typed.length);
  } });
  return { engine, typed: () => typed };
}
const done: ToolCall = { name: 'done', input: { summary: '전송 완료' } };

describe('blocked', () => {
  it('목표에 없는 비밀값이 필요하면 blocked 로 곧바로 멈춘다(결과에 사유와 이름)', async () => {
    const { engine } = pinEngine('2580');
    const exec = scriptedExecutor([{ name: 'blocked', input: { reason: '간편비밀번호 입력 화면 — 목표에 PIN 이 없음', secret: 'SIMPLE_PIN' } }]);
    const r = await runAct(engine, '문 열기', { executor: exec });
    expect(r).toMatchObject({ ok: false, turns: 1, reason: expect.stringMatching(/^막힘: 간편비밀번호/), blocked: { reason: expect.any(String), secret: 'SIMPLE_PIN' } });
  });

  it('사람만 할 단계면 secret 은 빈 문자열 → blocked 에 이름 없음, 잘못된 이름도 버린다', async () => {
    const { engine } = pinEngine('2580');
    const r = await runAct(engine, '문 열기', { executor: scriptedExecutor([{ name: 'blocked', input: { reason: '휴대폰 본인인증 필요', secret: '' } }]) });
    expect(r.blocked).toEqual({ reason: '휴대폰 본인인증 필요' });
    const r2 = await runAct(engine, '문 열기', { executor: scriptedExecutor([{ name: 'blocked', input: { reason: 'x', secret: 'pin code' } }]) });
    expect(r2.blocked).toEqual({ reason: 'x' });
  });
});

describe('enter_secret', () => {
  const secrets = () => new SecretBox([['SIMPLE_PIN', '2580']]);
  const goal = '차량 문 열기를 보내고 간편비밀번호 {{secret:SIMPLE_PIN}} 를 넣는다';

  it('키패드: 글자마다 다시 보고 그 글자의 키를 탭한다(누를 때마다 섞이는 배치) — 값은 모델 요청·기록에 없다', async () => {
    const { engine, typed } = pinEngine('2580');
    const exec = scriptedExecutor([{ name: 'enter_secret', input: { ref: '@pad', name: 'SIMPLE_PIN' } }, done]);
    const r = await runAct(engine, goal, { executor: exec, secrets: secrets() });
    expect(typed()).toBe('2580');
    expect(r).toMatchObject({ ok: true, turns: 2 });
    expect(JSON.stringify(exec.requests)).not.toContain('2580');
    expect(JSON.stringify(r.history)).not.toContain('2580');
    expect(r.recording?.actions).toEqual([{ tool: 'enter_secret', target: expect.objectContaining({ role: 'group' }), text: '{{secret:SIMPLE_PIN}}', summary: expect.any(String) }]);
  });

  it('입력칸이면 그대로 입력(type)', async () => {
    const engine = new FakeEngine({ root: { ref: '@r', role: 'root', children: [{ ref: '@pw', role: 'textbox', testId: 'com.app:id/pin', placeholder: 'PIN', states: { secure: true } }] } });
    const r = await runAct(engine, goal, { executor: scriptedExecutor([{ name: 'enter_secret', input: { ref: '@pw', name: 'SIMPLE_PIN' } }, done]), secrets: secrets() });
    expect(r.ok).toBe(true);
    expect(engine.performed).toEqual([{ ref: '@pw', action: 'type', arg: '2580' }]);
    expect(r.recording?.actions[0]).toMatchObject({ tool: 'enter_secret', target: { role: 'textbox' }, text: '{{secret:SIMPLE_PIN}}' });
  });

  it('목표에 자리표시가 없는 이름·없는 값은 오류(모델에게 사유), 키가 없으면 몇 번째 글자인지만(값은 숨김)', async () => {
    const { engine } = pinEngine('2580');
    const r = await runAct(engine, '문 열기', { executor: scriptedExecutor([{ name: 'enter_secret', input: { ref: '@pad', name: 'SIMPLE_PIN' } }, { name: 'blocked', input: { reason: 'PIN 없음', secret: 'SIMPLE_PIN' } }]), secrets: secrets() });
    expect(r.history[0]).toMatchObject({ result: 'error', detail: expect.stringMatching(/쓸 수 없는 비밀값.*SIMPLE_PIN/) });
    const blank = new FakeEngine({ root: keypad('1234567890', 0) });
    const noKey = await runAct(blank, goal, { executor: scriptedExecutor([{ name: 'enter_secret', input: { ref: '@pad', name: 'SIMPLE_PIN' } }, { name: 'blocked', input: { reason: '키 없음', secret: '' } }]), secrets: new SecretBox([['SIMPLE_PIN', '25#0']]) });
    expect(noKey.history[0]).toMatchObject({ result: 'error', detail: expect.stringMatching(/3번째 글자의 키/) });
    expect(JSON.stringify(noKey.history)).not.toContain('25#0');
  });

  it('녹화를 재생하면 같은 방식으로 다시 넣는다(섞인 키패드에서도, 모델 없이)', async () => {
    const first = pinEngine('2580');
    const rec = (await runAct(first.engine, goal, { executor: scriptedExecutor([{ name: 'enter_secret', input: { ref: '@pad', name: 'SIMPLE_PIN' } }, done]), secrets: secrets() })).recording!;
    const again = pinEngine('2580', '7418529630'); // 처음 배치부터 녹화 때와 다르다(라벨이 된 첫 키가 바뀜)
    const rp = await replayRecording(again.engine, { schema: 'rc-1', createdAt: 'x', start: {}, ...rec } as never, { goal, secrets: secrets(), endTimeoutMs: 200, quietMs: 0 });
    expect(again.typed()).toBe('2580');
    expect(rp.outcome).toBe('replayed');
  });
});

describe('반복 고리(agent-secrets 01)', () => {
  it('같은 호출 묶음(길이 2~4)이 세 번 연달아 반복되면 알리고, 네 번이면 멈춘다', async () => {
    const screens = ['A', 'B', 'C'].map((t): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@x', role: 'button', name: `다음 ${t}` }, { ref: '@y', role: 'button', name: '뒤로' }, { ref: '@z', role: 'button', name: '확인' }] }));
    let i = 0;
    const engine = new FakeEngine({ root: screens[0]!, onTap: () => screens[++i % 3] });
    const cycle: ToolCall[] = [{ name: 'tap', input: { ref: '@x' } }, { name: 'tap', input: { ref: '@y' } }, { name: 'tap', input: { ref: '@z' } }];
    const exec = scriptedExecutor([...cycle, ...cycle, ...cycle, ...cycle, done]);
    const r = await runAct(engine, '문 열기', { executor: exec });
    expect(exec.requests.map((q) => q.incident ?? '').join('|')).toMatch(/같은 호출 묶음\(tap @x → tap @y → tap @z\)이 세 번 반복/);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/같은 호출 묶음.*네 번 반복/) });
  });
});
