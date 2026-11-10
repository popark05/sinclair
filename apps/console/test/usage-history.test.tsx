// @vitest-environment jsdom
// 05 모델 사용(Cycle 화면의 절: 합계·타깃·테스트별, 호출 0 이면 숨김)과 06 안정성 이력(/console/tests: 색 칸 줄, flaky 비율, testId 거르기, 케이스 상세에서 링크).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { CycleUsage, HistoryView, CycleViewWithWarnings } from '@sinclair/control-plane';
import { UsageSection } from '../src/pages/UsageSection.tsx';
import { HistoryPage } from '../src/pages/HistoryPage.tsx';
import { CaseView } from '../src/pages/CaseView.tsx';
import type { Api } from '../src/api.ts';

afterEach(cleanup);
const t = (modelCalls: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number) => {
  const d = inputTokens + cacheReadTokens + cacheWriteTokens;
  return { modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheHitRate: d ? cacheReadTokens / d : null };
};
const usage: CycleUsage = { cycleId: 'c1', byModel: { 'claude-sonnet-5-5': { inputTokens: 24000, outputTokens: 3000, cacheReadTokens: 30376, cacheWriteTokens: 1984, cacheHitRate: 30376 / 56360 }, 'claude-haiku-5-5': { inputTokens: 740, outputTokens: 82, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 } }, total: t(25, 24740, 3082, 30376, 1984), byTarget: { android: t(25, 24740, 3082, 30376, 1984), ios: t(0, 0, 0, 0, 0) }, byTest: { '휴대전화 정보': t(7, 7466, 742, 6760, 1984), '검색': t(0, 0, 0, 0, 0) } };
const history: HistoryView = {
  cycles: [{ cycleId: 'c0', build: '1.0', createdAt: '2026-11-08T00:00:00.000Z' }, { cycleId: 'c1', build: '1.1', createdAt: '2026-11-09T00:00:00.000Z' }],
  tests: [
    { testId: '로그인', flakyRate: 0.5, stats: { passed: 1, 'passed-flaky': 1, failed: 0, blocked: 0, skipped: 0, waived: 0 }, cells: [{ cycleId: 'c0', build: '1.0', createdAt: '2026-11-08T00:00:00.000Z', targetId: 'android', verdict: 'passed' }, { cycleId: 'c1', build: '1.1', createdAt: '2026-11-09T00:00:00.000Z', targetId: 'android', verdict: 'passed-flaky' }] },
    { testId: '검색', flakyRate: 0, stats: { passed: 2, 'passed-flaky': 0, failed: 0, blocked: 0, skipped: 0, waived: 0 }, cells: [] },
  ],
};
const base: Api = { cycleSummaries: async () => [], cycle: async () => { throw new Error('x'); }, run: async () => { throw new Error('x'); }, fleet: async () => { throw new Error('x'); }, usage: async () => usage, history: async () => history, artifactUrl: () => '', issues: async () => [], triage: async (id) => ({ id }), deleteNode: async () => undefined };

describe('UsageSection', () => {
  it('합계(호출·입력·출력·캐시 읽기·쓰기·적중률)와 타깃·테스트별 표(호출 많은 순)', async () => {
    render(<UsageSection api={base} cycleId="c1" />);
    const sec = await screen.findByRole('region', { name: '모델 사용' });
    expect(sec.textContent).toMatch(/모델 호출\s*25/);
    expect(sec.textContent).toMatch(/캐시 적중률\s*53\.2%/); // 30376 / (24740 + 30376 + 1984)
    const byTest = within(sec).getByRole('table', { name: '테스트별' });
    expect(within(byTest).getAllByRole('row').slice(1).map((r) => r.firstChild!.textContent)).toEqual(['휴대전화 정보', '검색']);
    expect(within(byTest).getAllByRole('row')[2]!.textContent).toMatch(/검색.*0.*—/); // 분모 0 이면 —
    const byModel = within(sec).getByRole('table', { name: '모델별' });
    expect(within(byModel).getAllByRole('row').slice(1).map((r) => r.firstChild!.textContent)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']); // 입력 토큰 많은 순
    expect(byModel.textContent).toMatch(/claude-haiku-5-5.*740.*82/);
  });

  it('모델을 한 번도 안 불렀으면 절을 숨긴다(불러온 뒤에도)', async () => {
    let loaded = false;
    const { container } = render(<UsageSection api={{ ...base, usage: async () => { loaded = true; return { cycleId: 'c1', total: t(0, 0, 0, 0, 0), byTarget: {}, byTest: {}, byModel: {} }; } }} cycleId="c1" />);
    await vi.waitFor(() => expect(loaded).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});

describe('HistoryPage', () => {
  it('테스트별 색 칸 줄(오래된 → 최신), flaky 비율, 칸은 그 케이스 상세 링크', async () => {
    render(<HistoryPage api={base} />);
    const rows = await screen.findAllByRole('row');
    const login = rows.find((r) => r.textContent?.includes('로그인'))!;
    expect(login.textContent).toMatch(/50%/);
    const cells = within(login).getAllByRole('link').filter((a) => a.getAttribute('href')?.includes('/cases/'));
    expect(cells.map((a) => a.className)).toEqual(['spark cell-passed', 'spark cell-passed-flaky']);
    expect(cells[1]!.getAttribute('href')).toBe(`/console/cycles/c1/cases/${encodeURIComponent('로그인')}/android`);
    expect(cells[1]!.getAttribute('title')).toMatch(/1\.1.*android.*통과\(흔들림\)/);
  });

  it('testId 를 주면 그 테스트만 묻는다', async () => {
    const asked: unknown[] = [];
    render(<HistoryPage api={{ ...base, history: async (o) => { asked.push(o); return { ...history, tests: [history.tests[1]!] }; } }} testId="검색" />);
    expect(await screen.findByText('검색')).toBeTruthy();
    expect(asked).toEqual([{ limit: 20, testId: '검색' }]);
  });

  it('케이스 상세에는 그 테스트의 이력 링크', async () => {
    const cycle = { cycleId: 'c1', build: '1.1', targets: ['android'], requiredTags: [], createdAt: '2026-11-09T00:00:00.000Z', state: 'finished', verdict: 'verified', runs: [], retryLimit: 1, retriesUsed: {}, required: [], matrix: {} } as CycleViewWithWarnings;
    render(<CaseView api={{ ...base, cycle: async () => cycle }} cycleId="c1" testId="로그인" targetId="android" />);
    const link = await screen.findByRole('link', { name: '이 테스트의 이력' });
    expect(link.getAttribute('href')).toBe(`/console/tests?testId=${encodeURIComponent('로그인')}`);
  });
});
