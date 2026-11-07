// runner `screen` locator: 사용자 API 로만 검증한다. 관찰 대상은 FakeEngine 의 performed 기록과 오류 코드·메시지.
import { describe, it, expect } from 'vitest';
import { EngineError } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN, loginScenario } from '@sinclair/protocol/testing';
import { createScreen } from '../src/index.ts';

/** 테스트 기한: 페이크는 즉시 답하므로 짧게. 실패 경로는 150ms(대기 시간이 메시지에 남는지 볼 만큼), 대기 성공 경로는 2초 */
const QUICK_MS = 500, FAIL_MS = 150, WAIT_MS = 2_000, POLL_MS = 20, APPEAR_AFTER_MS = 150;

function setup(opts: { timeoutMs?: number } = {}) {
  const engine = loginScenario();
  const screen = createScreen(engine, { timeoutMs: opts.timeoutMs ?? QUICK_MS, pollMs: POLL_MS });
  return { engine, screen };
}

async function failure(p: Promise<unknown>): Promise<EngineError> {
  try { await p; } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('실패해야 하는데 성공함');
}

describe('screen.getBy* 와 액션', () => {
  it('getByRole(name) 으로 버튼을 찾아 tap 하면 엔진에 tap 이 간다', async () => {
    const { engine, screen } = setup();
    await screen.getByRole('button', { name: '로그인' }).tap();
    expect(engine.performed).toEqual([{ ref: '@e4', action: 'tap' }]);
  });

  it('getByTestId 로 입력 필드를 찾아 type 하면 엔진에 type 이 가고 value 로 읽을 수 있다', async () => {
    const { engine, screen } = setup();
    const field = screen.getByTestId('username');
    await field.type('popark');
    expect(engine.performed).toEqual([{ ref: '@e2', action: 'type', arg: 'popark' }]);
    expect(await field.value()).toBe('popark');
  });

  it('getByText/getByPlaceholder/getByLabel 과 exact 옵션', async () => {
    const { screen } = setup();
    expect(await screen.getByText('로그인').count()).toBe(1); // text 만 본다: 버튼의 name 은 getByRole/getByLabel 몫
    expect(await screen.getByText('Sinclair 로그인', { exact: true }).count()).toBe(1);
    expect(await screen.getByPlaceholder('아이디').count()).toBe(1);
    expect(await screen.getByLabel('회원가입').count()).toBe(1);
  });

  it('longPress/press/scrollIntoView 가 해당 액션으로 간다', async () => {
    const { engine, screen } = setup();
    const field = screen.getByTestId('username'); // 로그인 버튼은 길게 눌러도 화면이 바뀌므로 입력 필드로
    await field.longPress();
    await field.press('Enter');
    await field.scrollIntoView();
    expect(engine.performed.map((p) => p.action)).toEqual(['long_press', 'press', 'scroll_to']);
  });

  it('check 는 체크박스를 토글하고 select 는 콤보박스 값을 바꾼다', async () => {
    const { engine, screen } = setup();
    await screen.getByRole('checkbox', { name: '자동 로그인' }).check();
    await screen.getByRole('combobox', { name: '언어' }).select('en');
    expect(engine.performed).toEqual([{ ref: '@e6', action: 'check' }, { ref: '@e7', action: 'select', arg: 'en' }]);
    expect((await screen.getByRole('checkbox').resolve()).states?.checked).toBe(true);
    expect(await screen.getByRole('combobox').value()).toBe('en');
  });
});

describe('체이닝', () => {
  it('within 은 부모 locator 안에서만 찾고, nth/first 는 문서 순서로 고른다', async () => {
    const { engine, screen } = setup({ timeoutMs: FAIL_MS });
    const buttons = screen.getByRole('button');
    expect(await buttons.count()).toBe(2);
    await buttons.first().tap();
    expect(engine.performed.at(-1)).toEqual({ ref: '@e4', action: 'tap' });
    // 홈 화면으로 넘어갔다: 홈에는 버튼이 하나
    expect(await screen.getByRole('button').nth(0).count()).toBe(1);
    expect(await screen.getByRole('button').nth(5).count()).toBe(0);
    const root = screen.getByRole('root');
    expect(await screen.getByText('환영합니다').within(root).count()).toBe(1);
  });

  it('within 의 부모가 없으면 자식의 기한 하나만 쓴다(깊이만큼 늘지 않음)', async () => {
    const { screen } = setup({ timeoutMs: FAIL_MS });
    const start = Date.now();
    const e = await failure(screen.getByText('x').within(screen.getByRole('없는 역할').within(screen.getByRole('없는 역할2'))).tap());
    expect(e.code).toBe('not-found');
    expect(Date.now() - start).toBeLessThan(FAIL_MS * 2);
  });
});

describe('strict 와 자동 대기', () => {
  it('후보가 둘이면 ambiguous 이고 메시지에 질의와 후보 요약이 있다', async () => {
    const { screen } = setup();
    const e = await failure(screen.getByRole('button').tap());
    expect(e.code).toBe('ambiguous');
    expect(e.message).toContain('button');
    expect(e.message).toContain('@e4');
    expect(e.message).toContain('@e5');
    expect(e.message).toMatch(/2개/);
  });

  it('없는 요소는 기한까지 기다린 뒤 not-found 이고 메시지에 기다린 시간이 있다', async () => {
    const { screen } = setup({ timeoutMs: FAIL_MS });
    const start = Date.now();
    const e = await failure(screen.getByRole('button', { name: '없는 문구' }).tap());
    expect(Date.now() - start).toBeGreaterThanOrEqual(FAIL_MS - 10);
    expect(e.code).toBe('not-found');
    expect(e.details?.['waitedMs']).toBeGreaterThanOrEqual(FAIL_MS - 10);
    expect(e.message).toContain('없는 문구');
    // 마지막 화면의 관련 노드(같은 role) 요약이 들어 있어 무엇이 있었는지 알 수 있다
    expect(e.message).toContain('@e4');
    expect(e.message).toContain('회원가입');
  });

  it('나중에 나타나는 요소는 기다렸다가 탭한다', async () => {
    const { engine, screen } = setup({ timeoutMs: WAIT_MS });
    setTimeout(() => engine.setRoot(HOME_SCREEN), APPEAR_AFTER_MS);
    await screen.getByRole('button', { name: '로그아웃' }).tap();
    expect(engine.performed.at(-1)).toEqual({ ref: '@h2', action: 'tap' });
  });

  it('비활성 요소는 기한까지 기다린 뒤 not-actionable 이고, 그 사이 활성화되면 탭한다', async () => {
    const { screen } = setup({ timeoutMs: FAIL_MS });
    const e = await failure(screen.getByRole('button', { name: '회원가입' }).tap());
    expect(e.code).toBe('not-actionable');
    expect(e.message).toContain('회원가입');

    const live = setup({ timeoutMs: WAIT_MS });
    const enabled = structuredClone(LOGIN_SCREEN);
    delete enabled.children![4]!.states;
    setTimeout(() => live.engine.setRoot(enabled), APPEAR_AFTER_MS);
    await live.screen.getByRole('button', { name: '회원가입' }).tap();
    expect(live.engine.performed.at(-1)).toEqual({ ref: '@e5', action: 'tap' });
  });

  it('locator 는 lazy 라 만들 때 엔진을 부르지 않고, 호출마다 다시 조회한다', async () => {
    const { engine, screen } = setup();
    const calls = () => engine.locateCalls;
    void engine;
    const loc = screen.getByRole('button', { name: '로그인' });
    expect(calls()).toBe(0);
    await loc.count();
    await loc.count();
    expect(calls()).toBe(2);
  });
});

describe('secure 요소', () => {
  it('text/value 읽기는 secure-read 로 거부되고 type 은 된다', async () => {
    const { engine, screen } = setup();
    const pw = screen.getByTestId('password');
    const e = await failure(pw.value());
    expect(e.code).toBe('secure-read');
    await pw.type('hunter3');
    expect(engine.performed.at(-1)).toEqual({ ref: '@e3', action: 'type', arg: 'hunter3' });
  });
});
