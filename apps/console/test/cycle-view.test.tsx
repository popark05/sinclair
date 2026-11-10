// @vitest-environment jsdom
// Cycle 화면: 테스트 × 타깃 매트릭스(셀 색·문구·필수·범례), 머리(빌드·상태·Verdict·경고), Run 행(대체 관계·기기 끝 4자리), 끝나지 않은 동안 5초마다 새로 고침.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, act } from '@testing-library/react';
import type { CycleViewWithWarnings } from '@sinclair/control-plane';
import { CycleView, REFRESH_MS } from '../src/pages/CycleView.tsx';
import { ApiError, type Api } from '../src/api.ts';
import { STUBS } from './stubs.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const view = (over: Partial<CycleViewWithWarnings> = {}): CycleViewWithWarnings => ({
  cycleId: 'c1', build: '2.1.0', targets: ['android', 'ios'], requiredTags: ['smoke'], createdAt: '2026-11-09T01:00:00.000Z',
  state: 'running', verdict: 'incomplete', retryLimit: 1, retriesUsed: { android: 1 },
  required: ['로그인 @smoke'],
  runs: [
    { runId: 'r1', targetId: 'android', state: 'infra-failed', lease: { agentId: 'node-a', expiresAt: '2026-11-09T01:01:00.000Z', deviceId: 'R3CN30ABCDXLZW' }, replacedBy: 'retry:r1', abandonedAt: '2026-11-09T01:03:00.000Z' },
    { runId: 'retry:r1', targetId: 'android', state: 'running', lease: { agentId: 'node-b', expiresAt: '2026-11-09T01:05:00.000Z', deviceId: 'emulator-5554' }, replaces: 'r1' },
    { runId: 'r2', targetId: 'ios', state: 'queued' },
  ],
  matrix: {
    '로그인 @smoke': { android: { verdict: 'passed-flaky', attemptId: 'a2' }, ios: { verdict: 'failed', attemptId: 'a3' } },
    '검색': { android: { verdict: 'blocked' } },
  },
  warnings: ['run r9: 이벤트의 targetId(x)가 등록(y)과 다름'],
  ...over,
});
const apiOf = (next: () => CycleViewWithWarnings): Api & { calls: number } => {
  const api = { calls: 0, ...STUBS, cycleSummaries: async () => [], run: async () => { throw new Error('x'); }, fleet: async () => { throw new Error('x'); },
    cycle: async () => { api.calls++; return next(); } };
  return api as Api & { calls: number };
};

describe('CycleView', () => {
  it('매트릭스: 행 = 테스트, 열 = 타깃, 셀 문구·색, 빈 칸은 대기, 필수 표시, 셀은 상세 링크', async () => {
    render(<CycleView api={apiOf(() => view())} cycleId="c1" />);
    const grid = await screen.findByRole('table', { name: '매트릭스' });
    const rows = within(grid).getAllByRole('row');
    expect(within(rows[0]!).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['테스트', 'android', 'ios']);
    expect(within(rows[1]!).getByRole('rowheader').textContent).toMatch(/로그인 @smoke.*필수/);
    const flaky = within(rows[1]!).getByText('통과(흔들림)');
    expect(flaky.closest('td')!.className).toMatch(/cell-passed-flaky/);
    expect(within(rows[1]!).getByText('실패').closest('a')!.getAttribute('href')).toBe(`/console/cycles/c1/cases/${encodeURIComponent('로그인 @smoke')}/ios`);
    expect(within(rows[2]!).getByText('막힘')).toBeTruthy();
    expect(within(rows[2]!).getByText('대기').closest('td')!.className).toMatch(/cell-pending/);
    expect(screen.getByRole('list', { name: '범례' }).textContent).toMatch(/통과.*통과\(흔들림\).*실패.*막힘.*건너뜀.*면제.*대기/);
  });

  it('머리: 빌드·상태·Verdict·경고', async () => {
    render(<CycleView api={apiOf(() => view())} cycleId="c1" />);
    const head = await screen.findByRole('banner', { name: 'Cycle' });
    expect(head.textContent).toMatch(/2\.1\.0.*진행 중.*판정 전/);
    expect(screen.getByRole('list', { name: '경고' }).textContent).toMatch(/targetId/);
  });

  it('Run 행: 대체 관계·버려진 시각·기기 끝 4자리·노드, 타깃별 대체 횟수/한도', async () => {
    render(<CycleView api={apiOf(() => view())} cycleId="c1" />);
    const runs = await screen.findByRole('table', { name: 'Run' });
    const [, r1, r2, r3] = within(runs).getAllByRole('row');
    expect(r1!.textContent).toMatch(/android.*인프라 실패.*…XLZW.*node-a.*retry:r1 로 대체됨/);
    expect(r1!.textContent).not.toContain('R3CN30ABCD');
    expect(r2!.textContent).toMatch(/r1 을 대체/);
    expect(r3!.textContent).toMatch(/ios.*대기/);
    expect(screen.getByText(/대체 android 1\/1/)).toBeTruthy();
  });

  it('Run 행: 취소로 다시 등록된 Run 은 "취소돼 다시 등록" 이고 버려짐 시각·한도 문구가 없다', async () => {
    const runs: CycleViewWithWarnings['runs'] = [
      { runId: 'c', targetId: 'android', state: 'cancelled', replacedBy: 'retry:c' },
      { runId: 'retry:c', targetId: 'android', state: 'queued', replaces: 'c', replaceReason: 'cancelled' },
    ];
    render(<CycleView api={apiOf(() => view({ runs, retriesUsed: { android: 0, ios: 0 } }))} cycleId="c1" />);
    const table = await screen.findByRole('table', { name: 'Run' });
    const [, r1, r2] = within(table).getAllByRole('row');
    expect(r1!.textContent).toMatch(/취소됨.*retry:c 로 대체됨/);
    expect(r1!.textContent).not.toMatch(/버려짐/);
    expect(r2!.textContent).toMatch(/c 가 취소돼 다시 등록/);
    expect(screen.queryByText(/대체 android/)).toBeNull();
    expect(screen.getByText(/재시도 한도를 쓰지 않고 다시 등록/)).toBeTruthy();
  });

  it('끝나지 않은 동안 5초마다 새로 고치고, 끝나면 멈춘다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: CycleViewWithWarnings['state'] = 'running';
    const api = apiOf(() => view({ state }));
    render(<CycleView api={api} cycleId="c1" />);
    await screen.findByRole('table', { name: '매트릭스' });
    expect(api.calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS); });
    expect(api.calls).toBe(2);
    state = 'finished';
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS); });
    expect(api.calls).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 3); });
    expect(api.calls).toBe(3); // 끝난 Cycle 은 더 부르지 않는다
    expect(REFRESH_MS).toBe(5000);
  });

  it('모르는 Cycle 은 오류 안내', async () => {
    const api: Api = { ...STUBS, cycleSummaries: async () => [], run: async () => { throw new Error('x'); }, fleet: async () => { throw new Error('x'); }, cycle: async () => { throw new Error('404 모르는 Cycle'); } };
    render(<CycleView api={api} cycleId="nope" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/모르는 Cycle/);
  });
});

describe('CycleView · 새로 고침 리뷰 반영', () => {
  it('일시 오류(서버 재시작 등)에는 이전 화면을 두고 오류를 알리며 다시 시도하고, 404 면 멈춘다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail: Error | undefined;
    const api = apiOf(() => { if (fail) throw fail; return view(); });
    render(<CycleView api={api} cycleId="c1" />);
    await screen.findByRole('table', { name: '매트릭스' });
    fail = new ApiError('control-plane 에 닿지 않음: fetch failed');
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS); });
    expect(screen.getByRole('table', { name: '매트릭스' })).toBeTruthy(); // 이전 화면 유지
    expect(screen.getByRole('status').textContent).toMatch(/새로 고치지 못함.*닿지 않음/);
    fail = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 2); });
    expect(screen.queryByRole('status')).toBeNull(); // 다시 붙었다
    const calls = api.calls;
    fail = new ApiError('404 모르는 Cycle', 404);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 10); });
    expect(api.calls).toBe(calls + 1); // 404 뒤로는 부르지 않는다
  });

  it('다른 Cycle 로 바뀌면 이전 Cycle 의 화면을 보이지 않고 불러오는 중으로', async () => {
    let gate: (() => void) | undefined;
    const api: Api = { ...STUBS, cycleSummaries: async () => [], run: async () => { throw new Error('x'); }, fleet: async () => { throw new Error('x'); },
      cycle: async (id) => { if (id === 'c2') await new Promise<void>((r) => { gate = r; }); return view({ cycleId: id, build: id === 'c2' ? '9.9.9' : '2.1.0', state: 'finished' }); } };
    const { rerender } = render(<CycleView api={api} cycleId="c1" />);
    expect((await screen.findByRole('banner', { name: 'Cycle' })).textContent).toMatch(/2\.1\.0/);
    rerender(<CycleView api={api} cycleId="c2" />);
    expect(screen.queryByText('2.1.0')).toBeNull();
    expect(screen.getByText(/불러오는 중/)).toBeTruthy();
    await act(async () => { gate!(); });
    expect((await screen.findByRole('banner', { name: 'Cycle' })).textContent).toMatch(/9\.9\.9/);
  });

  it('Run 상태는 한국어로', async () => {
    render(<CycleView api={apiOf(() => view())} cycleId="c1" />);
    const runs = await screen.findByRole('table', { name: 'Run' });
    expect(runs.textContent).toMatch(/인프라 실패.*진행 중.*대기/);
  });
});
