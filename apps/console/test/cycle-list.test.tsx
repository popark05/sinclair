// @vitest-environment jsdom
// Cycle 목록 화면: 가짜 API 로 렌더해 최신순 행, 상태·Verdict 배지, 진행률, 빈 목록·오류 안내를 본다.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { CycleSummary } from '@sinclair/control-plane';
import { CycleList } from '../src/pages/CycleList.tsx';
import { ApiError, type Api } from '../src/api.ts';

afterEach(cleanup);
const fakeApi = (summaries: CycleSummary[] | Error): Api => ({
  cycleSummaries: async () => { if (summaries instanceof Error) throw summaries; return summaries; },
  cycle: async () => { throw new Error('안 씀'); }, run: async () => { throw new Error('안 씀'); }, fleet: async () => { throw new Error('안 씀'); },
});
const row = (c: Partial<CycleSummary> & { cycleId: string }): CycleSummary => ({ build: '1.0', targets: ['android'], createdAt: '2026-11-09T01:00:00.000Z', state: 'running', verdict: 'incomplete', runs: { total: 2, finished: 1 }, ...c });

describe('CycleList', () => {
  it('서버가 준 순서(최신순)대로 빌드·상태·Verdict·진행률을 보이고 Cycle 화면으로 링크한다', async () => {
    render(<CycleList api={fakeApi([row({ cycleId: 'c-new', build: '2.1.0', state: 'running', verdict: 'incomplete', runs: { total: 3, finished: 1 } }), row({ cycleId: 'c-old', build: '2.0.9', state: 'finished', verdict: 'verified', runs: { total: 2, finished: 2 } })])} />);
    const rows = await screen.findAllByRole('row');
    const body = rows.slice(1); // 머리 행 제외
    expect(body.map((r) => within(r).getByRole('link').textContent)).toEqual(['2.1.0', '2.0.9']);
    expect(within(body[0]!).getByText('진행 중')).toBeTruthy();
    expect(within(body[0]!).getByText('판정 전')).toBeTruthy();
    expect(within(body[0]!).getByText('1/3')).toBeTruthy();
    expect(within(body[1]!).getByText('검증됨')).toBeTruthy();
    expect(within(body[0]!).getByRole('link').getAttribute('href')).toBe('/console/cycles/c-new');
  });

  it('비면 안내, 서버 오류면 그 사유', async () => {
    render(<CycleList api={fakeApi([])} />);
    expect(await screen.findByText(/아직 Cycle 이 없음/)).toBeTruthy();
    cleanup();
    render(<CycleList api={fakeApi(new ApiError('control-plane 에 닿지 않음: fetch failed'))} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/control-plane 에 닿지 않음/));
  });
});
