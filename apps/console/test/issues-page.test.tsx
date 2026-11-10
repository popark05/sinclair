// @vitest-environment jsdom
// Issue 화면: 서명으로 묶인 실패(요약·errorCode·발생 수·테스트·최근 발생 링크), 추천 분류, 사람이 분류·메모·티켓을 저장.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import type { IssueView } from '@sinclair/control-plane';
import { IssuesPage } from '../src/pages/IssuesPage.tsx';
import type { Api } from '../src/api.ts';
import { STUBS } from './stubs.ts';

afterEach(cleanup);
const issues: IssueView[] = [
  { id: 'aaaaaaaaaaaa', errorCode: 'not-found', summary: 'tap { text="결제" } → 실패: 노드가 없음', count: 4, tests: ['결제', '장바구니 결제'], occurrences: [{ cycleId: 'c1', build: '1.1', testId: '결제', targetId: 'android', runId: 'r1', attemptId: 'a1', at: '2026-11-10T00:00:00.000Z' }] },
  { id: 'bbbbbbbbbbbb', errorCode: 'device-unavailable', summary: '', count: 2, tests: ['로그인'], suggested: 'infra', category: 'infra', note: '케이블', ticketUrl: 'https://jira.example.com/QA-2', occurrences: [] },
];
const apiWith = (saved: unknown[]): Api => ({ ...STUBS, cycleSummaries: async () => [], cycle: async () => { throw new Error('x'); }, run: async () => { throw new Error('x'); }, fleet: async () => { throw new Error('x'); },
  issues: async () => issues, triage: async (id, patch) => { saved.push({ id, patch }); return { id, ...patch }; } } as Api);

describe('IssuesPage', () => {
  it('묶인 실패: 요약·errorCode·발생 수·테스트, 최근 발생은 케이스 상세 링크, 추천·저장된 분류', async () => {
    render(<IssuesPage api={apiWith([])} />);
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows[0]!.textContent).toMatch(/결제.*노드가 없음.*not-found.*4.*결제, 장바구니 결제/);
    expect(within(rows[0]!).getByRole('link', { name: /최근/ }).getAttribute('href')).toBe(`/console/cycles/c1/cases/${encodeURIComponent('결제')}/android`);
    expect((within(rows[0]!).getByRole('combobox', { name: '분류' }) as HTMLSelectElement).value).toBe('');
    expect((within(rows[1]!).getByRole('combobox', { name: '분류' }) as HTMLSelectElement).value).toBe('infra');
    expect(rows[1]!.textContent).toMatch(/추천: 인프라/);
    expect(within(rows[1]!).getByRole('link', { name: '티켓' }).getAttribute('href')).toBe('https://jira.example.com/QA-2');
  });

  it('주소의 #<id> 인 Issue 행을 강조한다(케이스 상세에서 온 링크)', async () => {
    window.history.pushState({}, '', '/console/issues#bbbbbbbbbbbb');
    try {
      render(<IssuesPage api={apiWith([])} />);
      const rows = (await screen.findAllByRole('row')).slice(1);
      expect(rows[1]!.className).toMatch(/issue-target/);
      expect(rows[1]!.getAttribute('aria-current')).toBe('true');
      expect(rows[0]!.className).not.toMatch(/issue-target/);
      expect(rows[0]!.id).toBe('issue-aaaaaaaaaaaa');
    } finally { window.history.pushState({}, '', '/'); }
  });

  it('분류·메모·티켓을 고르고 저장하면 PUT 한다', async () => {
    const saved: unknown[] = [];
    render(<IssuesPage api={apiWith(saved)} />);
    const row = (await screen.findAllByRole('row'))[1]!;
    fireEvent.change(within(row).getByRole('combobox', { name: '분류' }), { target: { value: 'product' } });
    fireEvent.change(within(row).getByRole('textbox', { name: '메모' }), { target: { value: '결제 버튼 사라짐' } });
    fireEvent.change(within(row).getByRole('textbox', { name: '티켓 주소' }), { target: { value: 'https://jira.example.com/QA-1' } });
    fireEvent.click(within(row).getByRole('button', { name: '저장' }));
    expect(await within(row).findByText('저장됨')).toBeTruthy();
    expect(saved).toEqual([{ id: 'aaaaaaaaaaaa', patch: { category: 'product', note: '결제 버튼 사라짐', ticketUrl: 'https://jira.example.com/QA-1' } }]);
  });
});
