// 코드로 내보내기(studio 06): 세션 기록 → *.sinclair.ts. 자연어(act + assert) 또는 결정적(녹화 액션을 그 화면에서 하나로 정해진 locator 로).
import { describe, it, expect } from 'vitest';
import { exportTest } from '../src/shared/export.ts';
import type { SessionExportInput } from '../src/shared/export.ts';

const record: SessionExportInput = {
  goal: 'YouTube 앱에서 "florence guerin" 을 검색한다',
  turns: [
    { tool: 'tap', target: '@e9', result: 'ok', locator: "screen.getByRole('button', { name: '검색', exact: true })" },
    { tool: 'type', target: '@e8', result: 'ok', locator: "screen.getByPlaceholder('YouTube 검색')" },
    { tool: 'tap', target: '@e7', result: 'rejected', guard: 'gone' },
    { tool: 'submit', target: '@e8', result: 'ok', locator: "screen.getByPlaceholder('YouTube 검색')" },
    { tool: 'scroll', target: '@e12', result: 'ok' },
    { tool: 'done', result: 'ok' },
  ],
  result: { ok: true, turns: 6, modelCalls: 6, recording: { actions: [
    { tool: 'tap', target: { role: 'button', label: '검색' }, summary: 'tap' },
    { tool: 'type', target: { role: 'textbox', placeholder: 'YouTube 검색' }, text: "florence guerin's", summary: 'type' },
    { tool: 'submit', target: { role: 'textbox', placeholder: 'YouTube 검색' }, summary: 'submit' },
    { tool: 'scroll', target: { role: 'list' }, direction: 'down', summary: 'scroll' },
  ], end: { anchors: [] } } },
  judgments: [{ statement: '검색 결과 목록이 열려 있다', pass: true, reason: '보인다' }, { statement: '광고가 없다', pass: false, reason: '광고가 보인다' }],
};

describe('exportTest', () => {
  it('자연어: app.open(앱이 있으면) + act + 참이었던 판정만 assert(거짓은 주석)', () => {
    expect(exportTest(record, { style: 'natural', testName: 'YouTube 검색', appId: 'com.google.android.youtube' })).toBe(`// Sinclair Studio 에서 내보냄: 에이전트 세션 1개(모델 6회)
import { test } from '@sinclair/runner';

test('YouTube 검색', async ({ app, agent }) => {
  await app.open('com.google.android.youtube');
  await agent.act('YouTube 앱에서 "florence guerin" 을 검색한다');
  await agent.assert('검색 결과 목록이 열려 있다');
  // 세션에서 거짓이었던 판정: agent.assert('광고가 없다') — 광고가 보인다
});
`);
  });

  it('결정적: 녹화 액션을 locator 코드로(입력 글자는 녹화에서, 따옴표 이스케이프), 거부된 턴은 빼고, 스크롤은 주석, 판정은 agent.assert', () => {
    const code = exportTest(record, { style: 'deterministic', testName: 'YouTube 검색' });
    expect(code).toBe(`// Sinclair Studio 에서 내보냄: 에이전트 세션의 액션을 결정적 locator 로(모델 없이 돈다 — 판정만 모델)
import { test } from '@sinclair/runner';

test('YouTube 검색', async ({ screen, agent }) => {
  // 목표: YouTube 앱에서 "florence guerin" 을 검색한다
  await screen.getByRole('button', { name: '검색', exact: true }).tap();
  await screen.getByPlaceholder('YouTube 검색').type('florence guerin\\'s');
  await screen.getByPlaceholder('YouTube 검색').press('Enter');
  // scroll down: 결정적 코드로 옮기지 않음 — 다음 대상이 화면 밖이면 scrollIntoView() 를 쓴다
  await agent.assert('검색 결과 목록이 열려 있다');
  // 세션에서 거짓이었던 판정: agent.assert('광고가 없다') — 광고가 보인다
});
`);
  });

  it('결정적으로 옮길 수 없는 액션(그 화면에서 하나로 정해지는 locator 가 없음)은 TODO 주석, 비밀값 자리표시는 secret()', () => {
    const r: SessionExportInput = { ...record, turns: [{ tool: 'type', target: '@e3', result: 'ok' }, { tool: 'done', result: 'ok' }], result: { ok: true, turns: 2, modelCalls: 2, recording: { actions: [{ tool: 'type', target: { role: 'textbox' }, text: '{{secret:QA_PASSWORD}}', summary: 'type' }], end: { anchors: [] } } }, judgments: [] };
    const code = exportTest(r, { style: 'deterministic', testName: '로그인' });
    expect(code).toContain("async ({ screen, secret }) =>");
    expect(code).toContain("// TODO type textbox: 이 화면에서 하나로 정해지는 locator 가 없음 — Inspector 로 고르세요. 입력: secret('QA_PASSWORD')");
  });

  it('자연어: 목표의 비밀값 자리표시는 secret() 으로 이어 붙인다', () => {
    const r = { ...record, goal: '비밀번호 {{secret:QA_PASSWORD}} 로 로그인', judgments: [] };
    expect(exportTest(r, { style: 'natural', testName: 'x' })).toContain("await agent.act(`비밀번호 ${secret('QA_PASSWORD')} 로 로그인`);");
  });
});
