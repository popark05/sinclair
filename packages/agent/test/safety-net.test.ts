// 액션 전 안전망: 모델이 고른 순간과 실행 순간 사이에 화면이 바뀌면(재렌더링·끼어듦·사라짐·동명) 다시 찾거나 실행하지 않는다.
import { describe, it, expect } from 'vitest';
import { FakeEngine } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { runAct, scriptedExecutor, type ToolCall } from '../src/index.ts';

const rect = (y: number) => ({ x: 0, y, width: 1080, height: 120 });
const btn = (ref: string, name: string, y: number): SemanticNode => ({ ref, role: 'button', name, rect: rect(y) });
const screen = (...children: SemanticNode[]): SemanticNode => ({ ref: '@r', role: 'root', children });
const BEFORE = screen(btn('@a', '취소', 0), btn('@b', '결제', 200));

/** 첫 턴에 모델이 답하는 순간 화면을 after 로 바꾸는 대본: tap @b → done */
function racing(engine: FakeEngine, after: SemanticNode | undefined, first: ToolCall = { name: 'tap', input: { ref: '@b' } }) {
  return scriptedExecutor((_req, i) => {
    if (i === 0) { if (after) engine.setRoot(after); return first; }
    return { name: 'done', input: { summary: 'x' } };
  });
}

describe('안전망 · 루프', () => {
  it('화면이 그대로면 그 ref 로 실행한다', async () => {
    const engine = new FakeEngine({ root: BEFORE });
    const r = await runAct(engine, '결제', { executor: racing(engine, undefined) });
    expect(engine.performed).toEqual([{ ref: '@b', action: 'tap' }]);
    expect(r.history[0]).toMatchObject({ result: 'ok' });
    expect(r.history[0]).not.toHaveProperty('retargeted');
  });

  it('재렌더링으로 ref 가 바뀌면(순서 변경) 다시 찾은 대상으로 실행하고 기록한다', async () => {
    const engine = new FakeEngine({ root: BEFORE });
    const r = await runAct(engine, '결제', { executor: racing(engine, screen(btn('@x', '결제', 0), btn('@y', '취소', 200))) });
    expect(engine.performed).toEqual([{ ref: '@x', action: 'tap' }]); // 같은 자리의 "취소" 를 누르지 않았다
    expect(r.history[0]).toMatchObject({ result: 'ok', retargeted: '@x' });
  });

  it('위에 배너가 끼어들어 같은 이름이 다른 위치로 가도 따라간다', async () => {
    const engine = new FakeEngine({ root: BEFORE });
    await runAct(engine, '결제', { executor: racing(engine, screen({ ref: '@n', role: 'text', text: '광고', rect: rect(0) }, btn('@a', '취소', 200), btn('@b2', '결제', 400))) });
    expect(engine.performed).toEqual([{ ref: '@b2', action: 'tap' }]);
  });

  it('대상이 사라지면 실행하지 않고 사유를 다음 턴에 돌려주며 턴에 센다', async () => {
    const engine = new FakeEngine({ root: BEFORE });
    const exec = racing(engine, screen(btn('@a', '취소', 0), { ref: '@s', role: 'progressbar', name: '불러오는 중' }));
    const r = await runAct(engine, '결제', { executor: exec });
    expect(engine.performed).toEqual([]);
    expect(r).toMatchObject({ ok: true, turns: 2 });
    expect(r.history[0]).toMatchObject({ result: 'rejected', guard: 'gone', detail: expect.stringMatching(/안전망.*@b.*결제.*사라짐/) });
    expect(exec.requests[1]!.history[0]!.detail).toMatch(/다시 골라/);
  });

  it('가릴 수 없는 동명 둘이 되면 애매함으로 실행하지 않는다', async () => {
    const engine = new FakeEngine({ root: screen({ ref: '@b', role: 'button', name: '결제' }) });
    const r = await runAct(engine, '결제', { executor: racing(engine, screen({ ref: '@1', role: 'button', name: '결제' }, { ref: '@2', role: 'button', name: '결제' })) });
    expect(engine.performed).toEqual([]);
    expect(r.history[0]).toMatchObject({ result: 'rejected', guard: 'ambiguous', detail: expect.stringMatching(/@1.*@2/) });
  });

  it('type·scroll 도 같은 검사를 거친다', async () => {
    const field = (ref: string, y: number): SemanticNode => ({ ref, role: 'textbox', placeholder: '검색', rect: rect(y) });
    const engine = new FakeEngine({ root: screen(field('@f', 0)) });
    await runAct(engine, '검색', { executor: racing(engine, screen(btn('@x', '닫기', 0), field('@f2', 200)), { name: 'type', input: { ref: '@f', text: '사과' } }) });
    expect(engine.performed).toEqual([{ ref: '@f2', action: 'type', arg: '사과' }]);
  });
});
