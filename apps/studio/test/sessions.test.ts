// @vitest-environment node
// 에이전트 세션(studio 05): 작업 프로세스가 고른 기기의 엔진에서 runAct 를 돌리며 턴·끝을 이벤트로 밀고, 중지·판정을 받는다.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { scriptedExecutor, type StepExecutor } from '@sinclair/agent';
import { createSessionManager } from '../src/worker/sessions.ts';
import type { SessionEvent } from '../src/shared/studio-ipc.ts';

const login = () => new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
const script = () => scriptedExecutor([{ name: 'type', input: { ref: '@e2', text: 'qa' } }, { name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '환영합니다' } }]);

function setup(executor: StepExecutor) {
  const events: Array<{ sessionId: string; event: SessionEvent }> = [];
  const engine = login();
  const m = createSessionManager({ engineFor: async () => engine, agent: async () => ({ executor }), emit: (sessionId, event) => events.push({ sessionId, event }) });
  const done = (id: string) => new Promise<SessionEvent>((resolve) => { const t = setInterval(() => { const d = events.find((e) => e.sessionId === id && e.event.type === 'done'); if (d) { clearInterval(t); resolve(d.event); } }, 5); });
  return { m, events, done, engine };
}

describe('createSessionManager', () => {
  it('목표를 돌려 턴마다 turn, 끝에 done(ok·요약·모델 호출·녹화)', async () => {
    const { m, events, done } = setup(script());
    const { sessionId } = await m.start('SER1', '아이디 qa 로 로그인');
    const end = await done(sessionId);
    expect(events.filter((e) => e.event.type === 'turn').map((e) => e.event.type === 'turn' && [e.event.index, e.event.turn.tool, e.event.turn.result])).toEqual([[0, 'type', 'ok'], [1, 'tap', 'ok'], [2, 'done', 'ok']]);
    expect(end).toMatchObject({ type: 'done', result: { ok: true, summary: '환영합니다', modelCalls: 3, recording: { actions: [expect.objectContaining({ tool: 'type' }), expect.objectContaining({ tool: 'tap' })] } } });
  });

  it('턴마다 그 화면에서 하나로 정해지는 locator(결정적 내보내기용), 결과에 시작 앱', async () => {
    const { m, events, done } = setup(script());
    const { sessionId } = await m.start('SER1', '로그인');
    const end = await done(sessionId);
    const turns = events.filter((e) => e.event.type === 'turn').map((e) => (e.event.type === 'turn' ? e.event.turn.locator : undefined));
    expect(turns).toEqual(["screen.getByTestId('com.app:id/username')", "screen.getByRole('button', { name: '로그인', exact: true })", undefined]);
    expect(end).toMatchObject({ result: { startApp: 'com.app' } });
  });

  it('restartApp 이면 그 앱을 처음 상태로 다시 띄운 뒤 목표를 돌리고, 결과에 freshStart', async () => {
    const { m, done, engine } = setup(script());
    await engine.perform('@e2', 'type', '남은 글자'); // 앞 세션이 남긴 상태
    const { sessionId } = await m.start('SER1', '로그인', { restartApp: 'com.app' });
    const end = await done(sessionId);
    expect(engine.sessionCalls).toEqual(['restart']);
    expect(end).toMatchObject({ result: { ok: true, freshStart: true } });
  });

  it('restartApp 없이 시작하면 지금 화면에서(restart 안 함), freshStart 없음', async () => {
    const { m, done, engine } = setup(script());
    const { sessionId } = await m.start('SER1', '로그인');
    const end = await done(sessionId);
    expect(engine.sessionCalls).toEqual([]);
    expect((end as { result: { freshStart?: boolean } }).result.freshStart).toBeUndefined();
  });

  it('restart 가 실패하면 목표를 돌리지 않고 done(ok false, 이유)', async () => {
    const { m, done, engine } = setup(script());
    engine.session.restart = async () => { throw new Error('앱이 설치되지 않음'); };
    const { sessionId } = await m.start('SER1', '로그인', { restartApp: 'com.missing' });
    expect(await done(sessionId)).toMatchObject({ result: { ok: false, reason: expect.stringMatching(/처음부터 시작하지 못함.*앱이 설치되지 않음/), modelCalls: 0 } });
  });

  it('요소 판정(studio 09): 러너 expect 로 지금 화면에서, 모델 없이 통과·실패와 사유', async () => {
    const neverCalled: StepExecutor = { next: () => Promise.reject(new Error('모델 금지')) };
    const { m } = setup(neverCalled);
    expect(await m.expectCheck('SER1', { role: 'button', name: '로그인', exact: true }, 'visible')).toEqual({ pass: true, reason: '통과' });
    expect(await m.expectCheck('SER1', { testId: 'com.app:id/username' }, 'value', '아무개')).toMatchObject({ pass: false, reason: expect.stringMatching(/toHaveValue/) });
    expect(await m.expectCheck('SER1', { text: '없는 글자', exact: true }, 'hidden')).toEqual({ pass: true, reason: '통과' });
  });

  it('중지하면 done(ok false, 중지됨)', async () => {
    const slow: StepExecutor = { next: (_r, sig) => new Promise((_, rej) => sig.addEventListener('abort', () => rej(new Error('aborted')), { once: true })) };
    const { m, done } = setup(slow);
    const { sessionId } = await m.start('SER1', '오래 걸리는 목표');
    await m.stop(sessionId);
    expect(await done(sessionId)).toMatchObject({ type: 'done', result: { ok: false, reason: '중지됨' } });
  });

  it('판정: 지금 화면에 대해 judgeAssert(참·거짓과 근거)', async () => {
    const judging: StepExecutor = { next: () => Promise.reject(new Error('x')), judge: async () => ({ answer: { pass: true, reason: '로그인 버튼이 보인다' } }) };
    const { m } = setup(judging);
    expect(await m.assert('SER1', '로그인 화면이다')).toEqual({ pass: true, reason: '로그인 버튼이 보인다' });
  });

  it('에이전트 설정이 없으면 시작하지 않고 그 사유로 던진다', async () => {
    const m = createSessionManager({ engineFor: async () => login(), agent: async () => { throw new Error('ANTHROPIC_API_KEY 없음'); }, emit: () => {} });
    await expect(m.start('SER1', '목표')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
