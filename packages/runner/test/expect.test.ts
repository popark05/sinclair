// runner `expect` 판정: 기한 안 폴링, .not, 실패 메시지, secure 거부, perform 미호출.
import { describe, it, expect as vexpect } from 'vitest';
import { EngineError } from '@sinclair/protocol';
import { HOME_SCREEN, LOGIN_SCREEN, loginScenario } from '@sinclair/protocol/testing';
import { createScreen, expect, AssertionError } from '../src/index.ts';

/** 페이크는 즉시 답하므로 기한을 짧게. 실패 경로 150ms, 대기 성공 경로 2초 */
const FAIL_MS = 150, WAIT_MS = 2_000, POLL_MS = 20, CHANGE_AFTER_MS = 150;

function setup(timeoutMs = FAIL_MS) {
  const engine = loginScenario();
  const screen = createScreen(engine, { timeoutMs: WAIT_MS, pollMs: POLL_MS }); // screen 기한은 길게: 판정이 expect 기한을 쓰는지 드러내기 위해
  const ex = (loc: Parameters<typeof expect>[0]) => expect(loc, { timeoutMs, pollMs: POLL_MS });
  return { engine, screen, ex };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('실패해야 하는데 통과함');
}

describe('expect(locator) 판정', () => {
  it('toBeVisible/toBeHidden/toHaveText/toContainText/toHaveValue/toBeChecked/toBeDisabled/toHaveCount 가 현재 화면에서 통과한다', async () => {
    const { engine, screen, ex } = setup();
    await ex(screen.getByRole('button', { name: '로그인' })).toBeVisible();
    await ex(screen.getByText('없는 문구')).toBeHidden();
    await ex(screen.getByRole('text')).toHaveText('Sinclair 로그인');
    await ex(screen.getByRole('text')).toContainText('로그인');
    await engine.perform('@e2', 'type', 'popark');
    engine.performed.length = 0;
    await ex(screen.getByTestId('username')).toHaveValue('popark');
    await ex(screen.getByRole('checkbox')).not.toBeChecked();
    await ex(screen.getByRole('button', { name: '회원가입' })).toBeDisabled();
    await ex(screen.getByRole('button')).toHaveCount(2);
    vexpect(engine.performed).toEqual([]); // 판정은 화면을 바꾸지 않는다
  });

  it('.not 은 각 판정을 뒤집고, 기한 안에 통과하는 순간 끝난다', async () => {
    const { screen, ex } = setup();
    await ex(screen.getByRole('button', { name: '로그인' })).not.toBeHidden();
    await ex(screen.getByRole('button', { name: '로그인' })).not.toBeDisabled();
    await ex(screen.getByRole('text')).not.toHaveText('다른 글');
    await ex(screen.getByRole('button')).not.toHaveCount(3);
  });

  it('잠시 뒤 바뀌는 값을 기다렸다가 통과한다(폴링)', async () => {
    const { engine, screen, ex } = setup(WAIT_MS);
    setTimeout(() => engine.setRoot(HOME_SCREEN), CHANGE_AFTER_MS);
    const start = Date.now();
    await ex(screen.getByText('환영합니다')).toBeVisible();
    const elapsed = Date.now() - start;
    vexpect(elapsed).toBeGreaterThanOrEqual(CHANGE_AFTER_MS - 10);
    vexpect(elapsed).toBeLessThan(WAIT_MS / 2); // 통과하는 순간 끝난다(기한을 다 쓰지 않음)
    await ex(screen.getByRole('button', { name: '로그인' })).toBeHidden();
  });

  it('실패하면 기대/실제와 마지막 관찰의 노드 요약이 담긴 AssertionError 다', async () => {
    const { engine, screen, ex } = setup();
    const e = await failure(ex(screen.getByRole('text')).toHaveText('다른 글'));
    vexpect(e).toBeInstanceOf(AssertionError);
    vexpect(e.message).toContain('다른 글');
    vexpect(e.message).toContain('Sinclair 로그인');
    vexpect(e.message).toContain('@e1');
    vexpect(e.message).toMatch(/\d+ms/);

    const missing = await failure(ex(screen.getByText('없음')).toBeVisible());
    vexpect(missing).toBeInstanceOf(AssertionError);
    vexpect(missing.message).toContain('없음');

    const count = await failure(ex(screen.getByRole('button')).toHaveCount(5));
    vexpect(count.message).toContain('5');
    vexpect(count.message).toContain('2');

    const visible = await failure(ex(screen.getByText('없음')).toBeVisible());
    vexpect(visible.message).toContain('0개');
    const checked = await failure(ex(screen.getByRole('checkbox')).toBeChecked());
    vexpect(checked.message).toContain('toBeChecked');
    vexpect(checked.message).toContain('@e6');
    const disabled = await failure(ex(screen.getByRole('button', { name: '로그인' })).toBeDisabled());
    vexpect(disabled.message).toContain('toBeDisabled');
    const value = await failure(ex(screen.getByTestId('username')).toHaveValue('x'));
    vexpect(value.message).toContain('toHaveValue("x")');
    const contains = await failure(ex(screen.getByRole('text')).toContainText('zzz'));
    vexpect(contains.message).toContain('Sinclair 로그인');
    vexpect(engine.performed).toEqual([]); // 실패 경로에서도 화면을 바꾸지 않는다
  });

  it('실패 메시지의 노드 요약은 5개까지만 싣고 나머지는 개수로 줄인다', async () => {
    const { engine, screen, ex } = setup();
    engine.setRoot({ ref: '@r', role: 'root', children: Array.from({ length: 8 }, (_, i) => ({ ref: `@b${i}`, role: 'button', name: `b${i}` })) });
    const e = await failure(ex(screen.getByRole('button')).toHaveCount(1));
    vexpect(e.message).toContain('@b4');
    vexpect(e.message).not.toContain('@b5');
    vexpect(e.message).toContain('외 3개');
  });

  it('둘 이상에 맞는 locator 로 단일 판정을 하면 .not 이어도 ambiguous 이고, toHaveCount 는 된다', async () => {
    const { screen, ex } = setup();
    for (const p of [ex(screen.getByRole('button')).toBeVisible(), ex(screen.getByRole('button')).not.toBeVisible(), ex(screen.getByRole('button')).not.toBeHidden(), ex(screen.getByRole('button')).toHaveText('x')]) {
      const e = await failure(p);
      vexpect(e).toBeInstanceOf(EngineError);
      vexpect((e as EngineError).code).toBe('ambiguous');
    }
    await ex(screen.getByRole('button')).toHaveCount(2);
  });

  it('노드가 없으면 내용·상태 판정은 .not 이어도 통과하지 않고 기한까지 기다린다(공허한 참 금지)', async () => {
    const { screen, ex } = setup();
    for (const p of [ex(screen.getByText('없음')).not.toHaveText('x'), ex(screen.getByText('없음')).not.toBeChecked(), ex(screen.getByText('없음')).not.toHaveValue('x'), ex(screen.getByText('없음')).not.toBeDisabled()]) {
      const e = await failure(p);
      vexpect(e).toBeInstanceOf(AssertionError);
      vexpect(e.message).toContain('노드 없음');
    }
    // 존재 판정의 .not 은 정상
    await ex(screen.getByText('없음')).not.toBeVisible();
    await ex(screen.getByRole('text')).not.toBeHidden();
    await ex(screen.getByRole('text')).not.toContainText('zzz');
  });

  it('secure 노드의 toHaveText/toHaveValue 는 secure-read 로 거부된다', async () => {
    const { screen, ex } = setup();
    for (const p of [ex(screen.getByTestId('password')).toHaveValue('hunter2'), ex(screen.getByTestId('password')).toHaveText('hunter2'), ex(screen.getByTestId('password')).toContainText('hunter')]) {
      const e = await failure(p);
      vexpect(e).toBeInstanceOf(EngineError);
      vexpect((e as EngineError).code).toBe('secure-read');
    }
    await ex(screen.getByTestId('password')).toBeVisible(); // 존재 판정은 된다
  });

  it('within 의 부모가 없으면 자식은 hidden 이고, 판정은 expect 의 기한을 쓴다', async () => {
    const { engine, screen, ex } = setup();
    const start = Date.now();
    await ex(screen.getByText('x').within(screen.getByRole('없는 역할'))).toBeHidden();
    vexpect(Date.now() - start).toBeLessThan(FAIL_MS * 3); // screen 기한(QUICK 보다 큰 값이어도) 이 아니라 expect 기한
    const e = await failure(ex(screen.getByText('x').within(screen.getByRole('없는 역할'))).toBeVisible());
    vexpect(e).toBeInstanceOf(AssertionError);
    vexpect(engine.performed).toEqual([]);
  });

  it('화면이 LOGIN 으로 돌아오면 toBeHidden 이 폴링으로 통과한다', async () => {
    const { engine, screen, ex } = setup(WAIT_MS);
    engine.setRoot(HOME_SCREEN);
    setTimeout(() => engine.setRoot(LOGIN_SCREEN), CHANGE_AFTER_MS);
    await ex(screen.getByText('환영합니다')).toBeHidden();
  });
});
