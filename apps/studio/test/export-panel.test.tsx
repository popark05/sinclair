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
function setup() {
  const calls: unknown[] = [];
  const api = {
    saveTestFile: async (name: string, content: string) => { calls.push(['file', name, content.length > 0]); return '/tmp/x.sinclair.ts'; },
    saveRecording: async (input: unknown) => { calls.push(['rec', input]); return { key: 'k'.repeat(64) }; },
  } as unknown as StudioApi;
  render(<ExportPanel api={api} record={record} appId="com.google.android.youtube" />);
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

  it('녹화 캐시에 저장: 테스트 이름·목표·시작 앱·녹화를 control-plane 으로', async () => {
    const { calls } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 이름' }), { target: { value: 'YouTube 검색' } });
    await act(async () => { screen.getByRole('button', { name: '녹화 캐시에 저장' }).click(); });
    expect(calls).toEqual([['rec', { controlPlane: 'http://127.0.0.1:4780', testId: 'YouTube 검색', goal: 'YouTube 에서 검색한다', app: 'com.google.android.youtube', recording: record.result!.recording }]]);
    expect(await screen.findByText(/녹화 캐시에 저장함/)).toBeTruthy();
  });
});
