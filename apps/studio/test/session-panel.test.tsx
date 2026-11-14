// @vitest-environment jsdom
// 세션 패널(studio 05): 목표 → 실행(기기·에이전트 준비돼야), 턴 타임라인, 끝 결과, 중지, 판정 추가.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import { SessionPanel } from '../src/renderer/src/SessionPanel.tsx';
import type { SessionEvent, StudioApi } from '../src/shared/studio-ipc.ts';

afterEach(cleanup);
// CodeBlock(문법 강조) 첫 렌더가 jsdom·병렬 실행에서 수 초 걸린다
vi.setConfig({ testTimeout: 20_000 });
function setup(over: Partial<StudioApi> = {}, deviceId = 'SER1', appId?: string) {
  let listener: ((e: { kind: 'session'; sessionId: string; payload: SessionEvent }) => void) | undefined;
  const calls: string[] = [];
  const api = {
    agentStatus: async () => ({ ready: true, model: 'claude-sonnet-5-5' }),
    startSession: async (d: string, goal: string, opts?: { restartApp?: string }) => { calls.push(`start ${d} ${goal}${opts?.restartApp ? ` restart=${opts.restartApp}` : ''}`); return { sessionId: 's1' }; },
    stopSession: async (id: string) => { calls.push(`stop ${id}`); },
    assertNow: async (d: string, st: string) => { calls.push(`assert ${d} ${st}`); return { pass: false, reason: '설정 화면이 보인다' }; },
    onEvent: (cb: typeof listener) => { listener = cb; return () => { listener = undefined; }; },
    ...over,
  } as unknown as StudioApi;
  render(<SessionPanel api={api} deviceId={deviceId} {...(appId ? { appId } : {})} />);
  const push = async (payload: SessionEvent) => { await act(async () => { listener?.({ kind: 'session', sessionId: 's1', payload }); }); };
  return { calls, push };
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
