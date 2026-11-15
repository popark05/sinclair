// @vitest-environment jsdom
// 내보내기(studio 06): 끝난 세션을 자연어·결정적 코드로 미리 보고, 복사·파일 저장·녹화 캐시 저장(자연어).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { ExportPanel } from '../src/renderer/src/ExportPanel.tsx';
import type { StudioApi } from '../src/shared/studio-ipc.ts';
import type { SessionRecord } from '../src/renderer/src/SessionPanel.tsx';

afterEach(cleanup);
// CodeBlock(문법 강조) 첫 렌더가 jsdom·병렬 실행에서 수 초 걸린다
vi.setConfig({ testTimeout: 20_000 });
const record: SessionRecord = {
  goal: 'YouTube 에서 검색한다',
  turns: [{ tool: 'tap', target: '@e9', result: 'ok', locator: "screen.getByRole('button', { name: '검색', exact: true })" }, { tool: 'done', result: 'ok' }],
  result: { ok: true, turns: 2, modelCalls: 2, startApp: 'com.google.android.youtube', recording: { actions: [{ tool: 'tap', target: { role: 'button', label: '검색' }, summary: 'tap' }], end: { anchors: [] } } },
  judgments: [{ statement: '결과가 보인다', pass: true, reason: '보임' }],
};
function setup(rec: SessionRecord = record) {
  const calls: unknown[] = [];
  const api = {
    saveTestFile: async (name: string, content: string) => { calls.push(['file', name, content.length > 0]); return '/tmp/x.sinclair.ts'; },
    saveRecording: async (input: unknown) => { calls.push(['rec', input]); return { key: 'k'.repeat(64) }; },
    getSettings: async () => ({ controlPlane: 'http://10.0.0.5:4780', testsDir: '/tmp/tests' }),
    runAsCycle: async (input: unknown) => { calls.push(['cycle', input]); return { cycleId: 'studio-1', consoleUrl: 'http://10.0.0.5:4780/console/cycles/studio-1' }; },
    cycleStatus: async (id: string) => { calls.push(['status', id]); return { state: 'finished', verdict: 'verified', runState: 'finished' }; },
    openConsole: async (u: string) => { calls.push(['open', u]); },
  } as unknown as StudioApi;
  render(<ExportPanel api={api} record={rec} appId="com.google.android.youtube" deviceId="R3CN30ABCDXLZW" deviceLabel="SM-N981N (…XLZW)" />);
  return { calls };
}

describe('ExportPanel', () => {
  it('자연어 미리보기 → 결정적으로 바꾸면 locator 코드', async () => {
    setup();
    const preview = () => screen.getByRole('region', { name: '내보낼 코드' }).textContent ?? '';
    expect(preview()).toMatch(/agent\.act\('YouTube 에서 검색한다'\)/);
    await act(async () => { screen.getByRole('radio', { name: '결정적' }).click(); });
    expect(preview()).toMatch(/getByRole\('button', \{ name: '검색', exact: true \}\)\.tap\(\)/);
  });

  it('복사·파일 저장(이름은 테스트 이름)', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { calls } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 이름' }), { target: { value: 'YouTube 검색' } });
    await act(async () => { screen.getByRole('button', { name: '복사' }).click(); });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("test('YouTube 검색'"));
    await act(async () => { screen.getByRole('button', { name: '파일로 저장' }).click(); });
    expect(calls).toEqual([['file', 'YouTube 검색', true]]);
    expect(await screen.findByText(/x\.sinclair\.ts/)).toBeTruthy();
  });

  it('녹화 키의 앱은 러너와 같은 값(세션 시작 화면의 앱, 모르면 빈 값) — 툴바 앱 id 가 아니다. iOS 는 화면 트리에 패키지가 없어 러너는 빈 값인데 Studio 가 번들 id 로 저장해 재생되지 않았다(실기)', async () => {
    const { startApp: _s, ...noApp } = record.result!;
    const ios: SessionRecord = { ...record, result: noApp };
    const calls: unknown[] = [];
    const api = { saveRecording: async (input: unknown) => { calls.push(input); return { key: 'k'.repeat(64) }; }, getSettings: async () => ({ controlPlane: 'http://10.0.0.5:4780', testsDir: '/tmp/tests' }) } as unknown as StudioApi;
    render(<ExportPanel api={api} record={ios} appId="com.apple.Preferences" deviceId="00008020-000B289011E2002E" deviceLabel="iPhone11,6 (…002E)" />);
    await act(async () => { screen.getByRole('button', { name: '녹화 캐시에 저장' }).click(); });
    expect(calls).toEqual([expect.objectContaining({ app: '' })]);
    // 내보낸 코드의 app.restart 는 툴바 앱 id 그대로
    expect(screen.getByRole('region', { name: '내보낼 코드' }).textContent).toMatch(/app\.restart\('com\.apple\.Preferences'\)/);
  });

  it('녹화 캐시에 저장: 테스트 이름·목표·시작 앱·녹화를 control-plane 으로', async () => {
    const { calls } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 이름' }), { target: { value: 'YouTube 검색' } });
    await act(async () => { screen.getByRole('button', { name: '녹화 캐시에 저장' }).click(); });
    expect(calls).toEqual([['rec', { controlPlane: 'http://10.0.0.5:4780', testId: 'YouTube 검색', goal: 'YouTube 에서 검색한다', app: 'com.google.android.youtube', recording: record.result!.recording }]]);
    expect(await screen.findByText(/녹화 캐시에 저장함/)).toBeTruthy();
  });

  it('앱 처음 화면에서 시작하지 않은 세션이면 경고(내보낸 테스트는 app.restart 로 처음 화면에서 시작)', async () => {
    setup();
    expect(await screen.findByText(/앱 처음 화면에서 시작하지 않은 세션/)).toBeTruthy();
  });

  it('처음부터 시작한 세션이면 경고 없음', async () => {
    setup({ ...record, result: { ...record.result!, freshStart: true } });
    await screen.findByRole('button', { name: '복사' });
    expect(screen.queryByText(/앱 처음 화면에서 시작하지 않은 세션/)).toBeNull();
  });

  it('Cycle 로 실행(studio-console 04): 자연어면 녹화를 먼저 저장하고, 고른 기기로 Cycle 을 등록해 상태를 보이며 Console 링크를 연다', async () => {
    const { calls } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 이름' }), { target: { value: 'YouTube 검색' } });
    await act(async () => { screen.getByRole('button', { name: 'Cycle 로 실행' }).click(); });
    expect(calls.map((c) => (c as unknown[])[0])).toEqual(['rec', 'cycle', 'status']);
    expect((calls[1] as unknown[])[1]).toMatchObject({ testName: 'YouTube 검색', deviceId: 'R3CN30ABCDXLZW', deviceLabel: 'SM-N981N (…XLZW)', code: expect.stringContaining("agent.act('YouTube 에서 검색한다')") });
    expect(await screen.findByText(/끝 · verified/)).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: 'Console 에서 보기' }).click(); });
    expect(calls.at(-1)).toEqual(['open', 'http://10.0.0.5:4780/console/cycles/studio-1']);
  });
});
