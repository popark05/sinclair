// @vitest-environment jsdom
// 케이스 상세: 그 타깃의 Run 들(대체된 Run 포함)에서 그 테스트의 Attempt 를 시도 번호 순으로, 스텝(종류·instruction·시간·모델·토큰)과 실패·안전망·Incident 표지, 아티팩트 키.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { CycleViewWithWarnings, RunView } from '@sinclair/control-plane';
import { CaseView } from '../src/pages/CaseView.tsx';
import { App } from '../src/App.tsx';
import { ApiError, type Api } from '../src/api.ts';
import { STUBS } from './stubs.ts';

afterEach(() => { cleanup(); window.history.pushState({}, '', '/'); });
const T = '로그인 @smoke';
const cycle: CycleViewWithWarnings = {
  cycleId: 'c1', build: '2.1.0', targets: ['android'], requiredTags: [], createdAt: '2026-11-09T01:00:00.000Z', state: 'finished', verdict: 'blocked',
  retryLimit: 1, retriesUsed: {}, required: [T],
  runs: [{ runId: 'r-old', targetId: 'android', state: 'infra-failed', replacedBy: 'r1' }, { runId: 'r1', targetId: 'android', state: 'finished', replaces: 'r-old' }, { runId: 'r-ios', targetId: 'ios', state: 'finished' }],
  matrix: { [T]: { android: { verdict: 'passed-flaky', attemptId: 'a2' } } },
};
const runs: Record<string, RunView> = {
  'r-old': { runId: 'r-old', state: 'infra-failed', targetId: 'android', attempts: [{ attemptId: 'a0', testId: T, attemptNo: 1, startedAt: '2026-11-09T01:00:00.000Z', artifacts: [], steps: [] }] },
  r1: { runId: 'r1', state: 'finished', targetId: 'android', deviceId: 'R3CN30ABCDXLZW', attempts: [
    { attemptId: 'a1', testId: T, attemptNo: 1, startedAt: '2026-11-09T01:05:00.000Z', finishedAt: '2026-11-09T01:05:12.000Z', result: 'failed', errorCode: 'agent', artifacts: [{ kind: 'screenshot', key: 'a1.screenshot.png' }, { kind: 'screen-tree', key: 'a1.screen-tree.json' }], steps: [
      { stepIndex: 0, kind: 'act', instruction: 'act "로그인" → tap @e4(안전망: 사라짐), tap @e4→@e9(다시 찾음), done (3턴) [Incident: permission→앱 사용 중에만 허용 ×1] → 실패: 턴 한도 3', modelCalls: 3, durationMs: 9000, usage: { inputTokens: 3000, outputTokens: 200, cacheReadTokens: 6000 } },
    ] },
    { attemptId: 'a2', testId: T, attemptNo: 2, startedAt: '2026-11-09T01:06:00.000Z', finishedAt: '2026-11-09T01:06:04.000Z', result: 'passed', artifacts: [], steps: [
      { stepIndex: 0, kind: 'locator', instruction: 'tap { role=button, name="로그인" }', modelCalls: 0, durationMs: 120 },
      { stepIndex: 1, kind: 'assert', instruction: 'agent.assert "홈 화면이다" → 참', modelCalls: 1, durationMs: 2100, usage: { inputTokens: 700, outputTokens: 90 } },
    ] },
    { attemptId: 'other', testId: '다른 테스트', attemptNo: 1, artifacts: [], steps: [] },
  ] },
};
const api: Api = { ...STUBS, cycleSummaries: async () => [], fleet: async () => { throw new Error('x'); }, cycle: async () => cycle, run: async (id) => { const r = runs[id]; if (!r) throw new Error(`404 ${id}`); return r; } };

describe('CaseView · 리뷰 반영', () => {
  it('이벤트가 아직 없는 대기 Run(대체 Run 이 막 등록됨)이 있어도 다른 Run 의 시도를 보인다', async () => {
    const withQueued = { ...cycle, runs: [...cycle.runs, { runId: 'retry:r1', targetId: 'android', state: 'queued' as const, replaces: 'r1' }] };
    const asked: string[] = [];
    const api2: Api = { ...api, cycle: async () => withQueued, run: async (id) => { asked.push(id); if (id.startsWith('retry:')) throw new ApiError('404 모르는 run', 404); return api.run(id); } };
    render(<CaseView api={api2} cycleId="c1" testId={T} targetId="android" />);
    expect((await screen.findAllByRole('region', { name: /시도/ })).length).toBe(3);
    expect(asked).not.toContain('retry:r1'); // 대기 Run 은 묻지도 않는다
  });
});

describe('CaseView', () => {
  it('대체된 Run 의 시도까지 시간 순, 셀 판정·결과·errorCode·소요 시간', async () => {
    render(<CaseView api={api} cycleId="c1" testId={T} targetId="android" />);
    const attempts = await screen.findAllByRole('region', { name: /시도/ });
    expect(attempts.map((a) => a.getAttribute('aria-label'))).toEqual(['시도 1 (r-old, 대체됨)', '시도 1 (r1)', '시도 2 (r1)']);
    expect(screen.getByRole('banner', { name: '케이스' }).textContent).toMatch(/로그인 @smoke.*android.*통과\(흔들림\)/);
    expect(attempts[1]!.textContent).toMatch(/실패.*agent.*12초/);
    expect(attempts[2]!.textContent).toMatch(/통과.*4초/);
    expect(screen.queryByText('다른 테스트')).toBeNull();
  });

  it('스텝 표: 종류·instruction·시간·모델·토큰, 실패 스텝 강조, 안전망·Incident 표지, 아티팩트 키', async () => {
    render(<CaseView api={api} cycleId="c1" testId={T} targetId="android" />);
    const failed = (await screen.findAllByRole('region', { name: /시도/ }))[1]!;
    const step = within(failed).getAllByRole('row')[1]!;
    expect(step.className).toMatch(/step-failed/);
    expect(step.textContent).toMatch(/act.*9\.0초.*3.*3,000 \/ 200 \/ 6,000/);
    expect(within(step).getByText('안전망 1')).toBeTruthy();
    expect(within(step).getByText('다시 찾음 1')).toBeTruthy();
    expect(within(step).getByText('Incident')).toBeTruthy();
    const arts = within(failed).getByRole('list', { name: '아티팩트' });
    expect(arts.textContent).toMatch(/screenshot.*a1\.screenshot\.png.*screen-tree/);
    // 스크린샷은 그림으로, 화면 트리는 링크로(control-plane 의 /artifacts/:runId/:key)
    expect(within(arts).getByRole('img', { name: /시도 1 의 마지막 화면/ }).getAttribute('src')).toBe('/artifacts/r1/a1.screenshot.png');
    expect(within(arts).getByRole('link', { name: 'a1.screen-tree.json' }).getAttribute('href')).toBe('/artifacts/r1/a1.screen-tree.json');
  });

  it('공유 링크로 바로 들어오면 그 화면, 결과 없는 케이스는 안내', async () => {
    window.history.pushState({}, '', `/console/cycles/c1/cases/${encodeURIComponent(T)}/android`);
    render(<App api={api} />);
    expect(await screen.findByRole('banner', { name: '케이스' })).toBeTruthy();
    cleanup();
    render(<CaseView api={api} cycleId="c1" testId="없는 테스트" targetId="android" />);
    expect(await screen.findByText(/이 케이스의 시도가 아직 없음/)).toBeTruthy();
  });
});
