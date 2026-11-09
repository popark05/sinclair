// Incident 복구 루프: 모델을 부르기 전에 끼어든 화면을 알아보고 결정적 복구를 먼저 한다(모델 호출·턴 없음). 상한을 넘기거나 안 통하면 모델에게 한 번 알리고, 그래도 안 되면 act 실패.
import { describe, it, expect } from 'vitest';
import { FakeEngine } from '@sinclair/protocol/testing';
import { EngineError, type SemanticNode } from '@sinclair/protocol';
import { runAct, scriptedExecutor, type ToolCall } from '../src/index.ts';
import { APP, PERMISSION, CRASH, LAUNCHER } from './fixtures/incident-screens.ts';

const DONE_SCREEN: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@d1', role: 'text', testId: 'com.shop:id/done', text: '결제 완료' }] };
const pay: ToolCall = { name: 'tap', input: { ref: '@a2' } };
const done: ToolCall = { name: 'done', input: { summary: '결제 완료' } };

describe('Incident 복구 · 루프', () => {
  it('권한 요청이 뜨면 모델에 묻지 않고 정책 버튼(허용)을 눌러 치우고, 기록한다', async () => {
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' ? PERMISSION : n.ref === '@p2' ? DONE_SCREEN : undefined) });
    const exec = scriptedExecutor([pay, done]);
    const r = await runAct(engine, '결제', { executor: exec });
    expect(r).toMatchObject({ ok: true, modelCalls: 2, turns: 2, incidents: [{ kind: 'permission', action: '앱 사용 중에만 허용', count: 1 }] });
    expect(engine.performed).toEqual([{ ref: '@a2', action: 'tap' }, { ref: '@p2', action: 'tap' }]);
    expect(exec.requests[1]!.observation).toMatch(/결제 완료/); // 모델은 권한 창을 보지 않았다
  });

  it('정책 deny 면 허용 안함을 누른다', async () => {
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' ? PERMISSION : n.ref === '@p4' ? DONE_SCREEN : undefined) });
    await runAct(engine, '결제', { executor: scriptedExecutor([pay, done]), incidents: { permission: 'deny' } });
    expect(engine.performed.at(-1)).toEqual({ ref: '@p4', action: 'tap' });
  });

  it('충돌 다이얼로그는 닫고 앱을 다시 연다, 런처로 튕기면 다시 연다', async () => {
    let crashed = false;
    const crash = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' && !crashed ? ((crashed = true), CRASH) : n.ref === '@a2' ? DONE_SCREEN : n.ref === '@c2' ? LAUNCHER : undefined) });
    const r = await runAct(crash, '결제', { executor: scriptedExecutor([pay, pay, done]) });
    expect(crash.sessionCalls).toEqual(['open']);
    expect(r.incidents).toEqual([{ kind: 'app-error', action: '앱 닫기 → 다시 열기', count: 1 }]);
    const out = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' ? LAUNCHER : undefined) });
    const r2 = await runAct(out, '결제', { executor: scriptedExecutor([pay, done]) });
    expect(out.sessionCalls).toEqual(['open']);
    expect(r2.incidents).toEqual([{ kind: 'left-app', action: '다시 열기', count: 1 }]);
  });

  it('복구해도 같은 창이 그대로면 결정적 복구를 멈추고 모델에게 한 번 알리며, 그래도 남으면 act 실패', async () => {
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' || n.ref === '@p2' || n.ref === '@p4' ? PERMISSION : undefined) });
    const exec = scriptedExecutor([pay, { name: 'tap', input: { ref: '@p4' } }, done]);
    const r = await runAct(engine, '결제', { executor: exec });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Incident 를 복구하지 못함: 권한 요청/) });
    expect(engine.performed.filter((p) => p.ref === '@p2')).toHaveLength(2); // 두 번 눌러도 그대로라 멈췄다
    expect(exec.requests[1]!.incident).toMatch(/권한 요청/);
    expect(exec.requests).toHaveLength(2);
  });

  it('종류별 상한을 넘기면(권한 요청 넷이 연달아) 모델에게 알린다', async () => {
    const perm = (i: number): SemanticNode => ({ ...structuredClone(PERMISSION), children: PERMISSION.children!.map((c) => (c.ref === '@p1' ? { ...c, name: `권한 ${i}` } : c)) });
    let k = 0;
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' || n.ref === '@p2' ? (k < 4 ? perm(++k) : DONE_SCREEN) : undefined) });
    const exec = scriptedExecutor([pay, { name: 'tap', input: { ref: '@p2' } }, done]);
    const r = await runAct(engine, '결제', { executor: exec });
    expect(r.ok).toBe(true);
    expect(exec.requests[1]!.incident).toMatch(/권한/);
    expect(r.incidents).toEqual([{ kind: 'permission', action: '앱 사용 중에만 허용', count: 3 }, { kind: 'permission', action: '모델에 알림', count: 1 }]);
  });

  it('입력 뒤 탭이 실패하면 키보드를 내리고 같은 호출을 한 번 다시 한다', async () => {
    const engine = new FakeEngine({ root: { ref: '@r', role: 'root', children: [{ ref: '@f', role: 'textbox', testId: 'com.shop:id/q', placeholder: '검색' }, { ref: '@go', role: 'button', testId: 'com.shop:id/go', name: '검색' }] } });
    const perform = engine.perform.bind(engine);
    let keyboardUp = false, dismissed = 0;
    engine.keyboard.dismiss = async () => { dismissed++; keyboardUp = false; };
    engine.perform = async (ref, a, arg) => { if (a === 'type') keyboardUp = true; if (a === 'tap' && keyboardUp) throw new EngineError('not-actionable', '키보드에 가려짐'); return perform(ref, a, arg); };
    const r = await runAct(engine, '검색', { executor: scriptedExecutor([{ name: 'type', input: { ref: '@f', text: '사과' } }, { name: 'tap', input: { ref: '@go' } }, done]) });
    expect(r).toMatchObject({ ok: true, turns: 3, incidents: [{ kind: 'keyboard', action: '키보드 내림', count: 1 }] });
    expect(dismissed).toBe(1);
    expect(r.history[1]).toMatchObject({ result: 'ok' });
  });

  it('같은 호출이 연달아 두 번 실패하면 모델에게 Incident 로 알리고, 세 번째면 act 실패', async () => {
    const engine = new FakeEngine({ root: APP });
    engine.perform = async () => { throw new EngineError('not-actionable', '비활성'); };
    const exec = scriptedExecutor([pay, pay, pay, done]);
    const r = await runAct(engine, '결제', { executor: exec });
    expect(exec.requests[2]!.incident).toMatch(/같은 호출.*두 번/);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Incident.*tap @a2/) });
  });
});

describe('Incident 복구 · 리뷰 반영', () => {
  const chrome = (field: string): SemanticNode => ({ ref: '@r', role: 'root', children: [{ ref: '@u', role: 'textbox', testId: 'com.android.chrome:id/url_bar', name: 'accounts.example.com' }, { ref: '@f', role: 'textbox', testId: 'com.android.chrome:id/field', placeholder: field }, { ref: '@n', role: 'button', testId: 'com.android.chrome:id/next', name: '다음' }] });

  it('다른 앱(브라우저 로그인)으로 넘어간 흐름은 여러 턴 이어져도 실패하지 않고, 알린 일이 기록된다', async () => {
    let step = 0;
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' ? chrome('이메일') : n.ref === '@n' ? (++step === 1 ? chrome('비밀번호') : DONE_SCREEN) : undefined) });
    const exec = scriptedExecutor([pay, { name: 'tap', input: { ref: '@n' } }, { name: 'tap', input: { ref: '@n' } }, done]);
    const r = await runAct(engine, '브라우저로 로그인하고 결제', { executor: exec });
    expect(r).toMatchObject({ ok: true, incidents: [{ kind: 'left-app', action: '모델에 알림', count: 1 }] });
    expect(exec.requests[1]!.incident).toMatch(/com.android.chrome/);
    expect(exec.requests[2]).not.toHaveProperty('incident'); // 한 번만 알린다
  });

  it('키보드가 떠 있다는 근거가 없으면 뒤로(dismiss)를 누르지 않는다; 대상이 비활성이면 키보드 탓이 아니다', async () => {
    const root: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@f', role: 'textbox', testId: 'com.shop:id/q', placeholder: '검색' }, { ref: '@go', role: 'button', testId: 'com.shop:id/go', name: '검색', states: { disabled: true } }] };
    const engine = new FakeEngine({ root });
    let dismissed = 0;
    engine.keyboard.dismiss = async () => { dismissed++; };
    const r = await runAct(engine, '검색', { executor: scriptedExecutor([{ name: 'type', input: { ref: '@f', text: '사과' } }, { name: 'tap', input: { ref: '@go' } }, done]) });
    expect(dismissed).toBe(0);
    expect(r.history[1]).toMatchObject({ result: 'error' });
    // shown 이 없는 엔진(키보드 상태를 모름)도 누르지 않는다
    const unknown = new FakeEngine({ root: { ...root, children: [root.children![0]!, { ...root.children![1]!, states: {} }] } });
    let d2 = 0;
    Object.assign(unknown.keyboard, { shown: undefined, dismiss: async () => { d2++; } });
    const perform = unknown.perform.bind(unknown);
    unknown.perform = async (ref, a, arg) => { if (a === 'tap') throw new EngineError('not-found', '가려짐'); return perform(ref, a, arg); };
    await runAct(unknown, '검색', { executor: scriptedExecutor([{ name: 'type', input: { ref: '@f', text: '사과' } }, { name: 'tap', input: { ref: '@go' } }, done]) });
    expect(d2).toBe(0);
  });

  it('앱을 다시 열 때 act 시작 때의 앱 패키지로 연다', async () => {
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@a2' ? LAUNCHER : undefined) });
    const opened: Array<string | undefined> = [];
    const open = engine.session.open;
    engine.session.open = async (t) => { opened.push(t); return open(t); };
    await runAct(engine, '결제', { executor: scriptedExecutor([pay, done]) });
    expect(opened).toEqual(['com.shop']);
  });

  it('모델이 고른 뒤 실행 전에 권한 창이 끼어들면 실행하지 않고, 다음 턴에 복구한다', async () => {
    const engine = new FakeEngine({ root: APP, onTap: (n) => (n.ref === '@p2' ? APP : undefined) });
    const exec = scriptedExecutor((_req, i) => { if (i === 0) { engine.setRoot(PERMISSION); return pay; } return done; });
    const r = await runAct(engine, '결제', { executor: exec });
    expect(r.history[0]).toMatchObject({ result: 'rejected', detail: expect.stringMatching(/끼어든 창.*권한 요청/) });
    expect(engine.performed).toEqual([{ ref: '@p2', action: 'tap' }]);
  });

  it('권한 버튼은 시스템 권한 창의 노드에서만 고른다(앱의 같은 id·같은 문구는 고르지 않는다)', async () => {
    const mixed: SemanticNode = { ref: '@r', role: 'root', children: [
      { ref: '@x', role: 'button', testId: 'com.shop:id/permission_allow_foreground_only_button', name: '앱 사용 중에만 허용' },
      ...PERMISSION.children!,
    ] };
    const { detectIncident } = await import('../src/index.ts');
    expect(detectIncident(mixed, { appPackage: 'com.shop' })).toMatchObject({ recovery: { ref: '@p2' } });
  });
});
