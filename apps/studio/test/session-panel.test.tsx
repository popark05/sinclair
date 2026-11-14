// @vitest-environment jsdom
// 세션 패널(studio 05): 목표 → 실행(기기·에이전트 준비돼야), 턴 타임라인, 끝 결과, 중지, 판정 추가.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import { SessionPanel } from '../src/renderer/src/SessionPanel.tsx';
import type { SessionEvent, StudioApi } from '../src/shared/studio-ipc.ts';

afterEach(cleanup);
// CodeBlock(문법 강조) 첫 렌더가 jsdom·병렬 실행에서 수 초 걸린다
vi.setConfig({ testTimeout: 20_000 });
function setup(over: Partial<StudioApi> = {}, deviceId = 'SER1', appId?: string, extra: { onBusyChange?: (b: boolean) => void; onTurn?: () => void } = {}) {
  let listener: ((e: { kind: 'session'; sessionId: string; payload: SessionEvent }) => void) | undefined;
  const calls: string[] = [];
  const api = {
    agentStatus: async () => ({ ready: true, model: 'claude-sonnet-5-5' }),
    startSession: async (d: string, goal: string, opts?: { restartApp?: string; secrets?: Record<string, string> }) => { calls.push(`start ${d} ${goal}${opts?.restartApp ? ` restart=${opts.restartApp}` : ''}${opts?.secrets ? ` secrets=${Object.keys(opts.secrets).join(',')}` : ''}`); return { sessionId: 's1' }; },
    stopSession: async (id: string) => { calls.push(`stop ${id}`); },
    assertNow: async (d: string, st: string) => { calls.push(`assert ${d} ${st}`); return { pass: false, reason: '설정 화면이 보인다' }; },
    onEvent: (cb: typeof listener) => { listener = cb; return () => { listener = undefined; }; },
    ...over,
  } as unknown as StudioApi;
  render(<SessionPanel api={api} deviceId={deviceId} {...(appId ? { appId } : {})} {...extra} />);
  const push = async (payload: SessionEvent) => { await act(async () => { listener?.({ kind: 'session', sessionId: 's1', payload }); }); };
  return { calls, push };
}


function setupWith(over: Partial<StudioApi>, props: Record<string, unknown> = {}) {
  const api = {
    agentStatus: async () => ({ ready: true, model: 'claude-sonnet-5-5' }),
    startSession: async () => ({ sessionId: 's1' }), stopSession: async () => {}, assertNow: async () => ({ pass: true, reason: '참' }),
    onEvent: () => () => {},
    ...over,
  } as unknown as StudioApi;
  const view = render(<SessionPanel api={api} deviceId="SER1" {...props} />);
  return { rerenderWith: (more: Record<string, unknown>) => view.rerender(<SessionPanel api={api} deviceId="SER1" {...props} {...more} />) };
}

describe('SessionPanel', () => {
  it('목표를 넣고 실행 → 턴이 쌓이고 끝나면 결과', async () => {
    const { calls, push } = setup();
    fireEvent.change(await screen.findByRole('textbox', { name: '목표' }), { target: { value: '로그인해줘' } });
    await act(async () => { screen.getByRole('button', { name: '실행' }).click(); });
    expect(calls).toEqual(['start SER1 로그인해줘']);
    await push({ type: 'turn', index: 0, turn: { tool: 'tap', target: '@e4', result: 'ok' } });
    await push({ type: 'turn', index: 1, turn: { tool: 'tap', target: '@e9', result: 'rejected', guard: 'gone', detail: '사라짐' } });
    await push({ type: 'done', result: { ok: true, summary: '환영합니다', turns: 2, modelCalls: 2 } });
    const turns = screen.getByRole('list', { name: '턴' });
    expect(within(turns).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/1.*tap @e4/), expect.stringMatching(/2.*tap @e9.*안전망: 사라짐/)]);
    expect(screen.getByRole('status', { name: '세션 결과' }).textContent).toMatch(/성공.*환영합니다.*모델 2회/);
  });

  it('앱 id 가 있으면 "앱 처음부터 시작" 이 기본으로 켜져 그 앱을 다시 띄우고 시작한다', async () => {
    const { calls } = setup({}, 'SER1', 'com.app');
    const box = await screen.findByRole('checkbox', { name: '앱 처음부터 시작' });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: '목표' }), { target: { value: '로그인' } });
    await act(async () => { screen.getByRole('button', { name: '실행' }).click(); });
    expect(calls).toEqual(['start SER1 로그인 restart=com.app']);
  });

  it('앱 id 가 없으면 "앱 처음부터 시작" 은 꺼지고 비활성', async () => {
    setup();
    const box = await screen.findByRole('checkbox', { name: '앱 처음부터 시작' });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(box.getAttribute('aria-disabled')).toBe('true'); // astryx 는 비활성도 초점을 받게 aria-disabled 를 쓴다
  });

  it('실행 중임과 턴마다를 알린다(Workspace 가 화면 폴링을 멈추고 턴마다 한 번 받는다)', async () => {
    const busy: boolean[] = []; let turns = 0;
    const { push } = setup({}, 'SER1', undefined, { onBusyChange: (b: boolean) => busy.push(b), onTurn: () => { turns++; } });
    fireEvent.change(await screen.findByRole('textbox', { name: '목표' }), { target: { value: '로그인' } });
    await act(async () => { screen.getByRole('button', { name: '실행' }).click(); });
    await push({ type: 'turn', index: 0, turn: { tool: 'tap', target: '@e4', result: 'ok' } });
    await push({ type: 'turn', index: 1, turn: { tool: 'done', result: 'ok' } });
    await push({ type: 'done', result: { ok: true, turns: 2, modelCalls: 2 } });
    expect(busy).toEqual([false, true, false]); // 처음 상태도 알린다
    expect(turns).toBe(2);
  });

  it('요소 판정(studio 09): 고른 노드가 없으면 안내, 있으면 검사 종류·값으로 판정해 목록에 쌓고 기록에 kind expect', async () => {
    const recs: unknown[] = [];
    const calls: unknown[] = [];
    const expectCheck = async (d: string, query: unknown, matcher: string, expected?: string) => { calls.push([d, query, matcher, expected]); return { pass: true, reason: '통과' }; };
    const target = { query: { text: '창신동', exact: true }, code: "screen.getByText('창신동', { exact: true })", text: '창신동' };
    const { rerenderWith } = setupWith({ expectCheck }, { onRecord: (r: unknown) => recs.push(r) });
    expect(await screen.findByText(/노드를 고르면 요소 판정/)).toBeTruthy();
    rerenderWith({ target });
    const kind = await screen.findByRole('combobox', { name: '검사 종류' });
    expect(kind).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '판정 값' })).toBeNull(); // 보인다 는 값이 없다
    await act(async () => { screen.getByRole('button', { name: '요소 판정' }).click(); });
    expect(calls).toEqual([['SER1', target.query, 'visible', undefined]]);
    const items = within(screen.getByRole('list', { name: '판정' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/통과 · expect\(screen.getByText\('창신동', \{ exact: true \}\)\).toBeVisible\(\)/);
    expect(recs.at(-1)).toMatchObject({ judgments: [{ kind: 'expect', query: target.query, matcher: 'visible', pass: true }] });
  });

  it('비밀값(agent-secrets 03): 넣으면 목표에 자리표시를 덧붙이고 목록에는 이름만, 실행에 값을 넘긴다; blocked 면 사유와 이름을 채워 둔다', async () => {
    const { calls, push } = setup();
    fireEvent.change(await screen.findByRole('textbox', { name: '목표' }), { target: { value: '차량 문을 연다' } });
    fireEvent.change(screen.getByRole('textbox', { name: '비밀값 이름' }), { target: { value: 'SIMPLE_PIN' } });
    fireEvent.change(screen.getByLabelText('비밀값 값'), { target: { value: '2580' } });
    await act(async () => { screen.getByRole('button', { name: '비밀값 추가' }).click(); });
    expect((screen.getByRole('textbox', { name: '목표' }) as HTMLTextAreaElement).value).toBe('차량 문을 연다\n비밀값 SIMPLE_PIN: {{secret:SIMPLE_PIN}}');
    const list = screen.getByRole('list', { name: '비밀값' });
    expect(list.textContent).toContain('SIMPLE_PIN');
    expect(document.body.textContent).not.toContain('2580');
    await act(async () => { screen.getByRole('button', { name: '실행' }).click(); });
    expect(calls).toEqual(['start SER1 차량 문을 연다\n비밀값 SIMPLE_PIN: {{secret:SIMPLE_PIN}} secrets=SIMPLE_PIN']);
    await push({ type: 'done', result: { ok: false, turns: 1, modelCalls: 1, reason: '막힘: 본인인증 화면', blocked: { reason: '본인인증 화면', secret: 'AUTH_CODE' } } });
    expect(screen.getByRole('status', { name: '세션 결과' }).textContent).toMatch(/막힘.*본인인증 화면.*AUTH_CODE/);
    expect((screen.getByRole('textbox', { name: '비밀값 이름' }) as HTMLInputElement).value).toBe('AUTH_CODE');
  });

  it('목표의 자리표시에 값이 없으면 실행하지 않고 알린다', async () => {
    const { calls } = setup();
    fireEvent.change(await screen.findByRole('textbox', { name: '목표' }), { target: { value: 'PIN {{secret:SIMPLE_PIN}} 로 연다' } });
    await act(async () => { screen.getByRole('button', { name: '실행' }).click(); });
    expect(calls).toEqual([]);
    expect(screen.getByText(/비밀값 SIMPLE_PIN 의 값을 넣어/)).toBeTruthy();
  });

  it('Run 이 이 기기를 쓰는 중이면(deviceInUse) 실행·판정을 막고 이유를 보인다', async () => {
    setupWith({}, { deviceInUse: true });
    fireEvent.change(await screen.findByRole('textbox', { name: '목표' }), { target: { value: '로그인' } });
    expect(screen.getByRole('button', { name: '실행' }).hasAttribute('disabled') || screen.getByRole('button', { name: '실행' }).getAttribute('aria-disabled') === 'true').toBe(true);
    expect(screen.getByText(/Run 이 이 기기를 쓰는 중/)).toBeTruthy();
  });

  it('실행 중에는 중지 버튼', async () => {
    const { calls } = setup();
    fireEvent.change(await screen.findByRole('textbox', { name: '목표' }), { target: { value: '오래' } });
    await act(async () => { screen.getByRole('button', { name: '실행' }).click(); });
    await act(async () => { screen.getByRole('button', { name: '중지' }).click(); });
    expect(calls).toEqual(['start SER1 오래', 'stop s1']);
  });

  it('판정 추가: 지금 화면에 대한 참·거짓과 근거', async () => {
    const { calls } = setup();
    fireEvent.change(await screen.findByRole('textbox', { name: '판정 문장' }), { target: { value: '홈 화면이다' } });
    await act(async () => { screen.getByRole('button', { name: '판정' }).click(); });
    expect(calls).toEqual(['assert SER1 홈 화면이다']);
    expect(within(screen.getByRole('list', { name: '판정' })).getByRole('listitem').textContent).toMatch(/거짓.*홈 화면이다.*설정 화면이 보인다/);
  });

  it('에이전트가 준비되지 않았거나 기기가 없으면 실행할 수 없고 이유를 보인다', async () => {
    setup({ agentStatus: async () => ({ ready: false, reason: 'ANTHROPIC_API_KEY 없음' }) } as Partial<StudioApi>);
    expect(await screen.findByText(/ANTHROPIC_API_KEY 없음/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '실행' }).getAttribute('aria-disabled')).toBe('true');
  });
});
