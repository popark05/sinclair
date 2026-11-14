// @vitest-environment node
// 내보낸 코드 왕복(studio 06): exportTest 가 만든 *.sinclair.ts 를 그대로 러너에 넣어 FakeEngine 에서 통과하는지.
// 파일은 studio 패키지 안 임시 디렉터리에 둔다 — 내보낸 코드의 `@sinclair/runner` import 가 이 패키지 의존성으로 풀리게.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { scriptedExecutor, type StepExecutor } from '@sinclair/agent';
import { runTests } from '@sinclair/runner';
import { exportTest, type SessionExportInput } from '../src/shared/export.ts';

const loginEngine = (): FakeEngine => new FakeEngine({ root: LOGIN_SCREEN, onTap: (node) => (node.name === '로그인' ? HOME_SCREEN : undefined) });
/** 판정만 하는 실행기: 화면에 "환영합니다" 가 있으면 참. act 는 부르면 안 된다(결정적 코드) */
const judgeOnly: StepExecutor = {
  next: () => Promise.reject(new Error('결정적 코드에서 act 모델 호출 금지')),
  judge: async (req) => { const home = /환영합니다/.test(req.observation); return { answer: { pass: home, reason: home ? '환영 문구' : '로그인 화면' } }; },
};

const session: SessionExportInput = {
  goal: '아이디 qa 와 비밀번호 {{secret:QA_PASSWORD}} 로 로그인한다',
  turns: [
    { tool: 'type', target: '@e2', result: 'ok', locator: "screen.getByTestId('com.app:id/username')" },
    { tool: 'type', target: '@e3', result: 'ok', locator: "screen.getByTestId('com.app:id/password')" },
    { tool: 'tap', target: '@e4', result: 'ok', locator: "screen.getByRole('button', { name: '로그인', exact: true })" },
    { tool: 'done', result: 'ok' },
  ],
  result: { ok: true, turns: 4, modelCalls: 4, recording: { actions: [
    { tool: 'type', target: { role: 'textbox', testId: 'com.app:id/username' }, text: 'qa', summary: 'type' },
    { tool: 'type', target: { role: 'textbox', testId: 'com.app:id/password' }, text: '{{secret:QA_PASSWORD}}', summary: 'type' },
    { tool: 'tap', target: { role: 'button', label: '로그인' }, summary: 'tap' },
  ], end: { anchors: [] } } },
  judgments: [{ statement: '환영 화면이 보인다', pass: true, reason: '환영합니다' }],
};

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const write = (code: string): string => {
  dir = fs.mkdtempSync(path.join(import.meta.dirname, '.roundtrip-'));
  const file = path.join(dir, 'exported.sinclair.ts');
  fs.writeFileSync(file, code);
  return file;
};

describe('내보낸 코드 왕복', () => {
  it('결정적: app.restart + locator 코드만으로 FakeEngine 에서 통과(act 모델 0회, 비밀값은 secret 저장소에서)', async () => {
    const file = write(exportTest(session, { style: 'deterministic', testName: '로그인', appId: 'com.example.app' }));
    const engine = loginEngine();
    const report = await runTests([file], { engine, timeoutMs: 2_000, secrets: { get: (n) => (n === 'QA_PASSWORD' ? 'pw-1' : undefined) }, agent: { executor: judgeOnly } });
    expect(report.tests.map((t) => [t.name, t.result])).toEqual([['로그인', 'passed']]);
  });

  it('자연어: app.open 없이 act + assert 가 FakeEngine 에서 통과(act 는 대본 실행기)', async () => {
    const file = write(exportTest({ ...session, goal: '로그인 버튼을 누른다' }, { style: 'natural', testName: '로그인' }));
    const script = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '로그인함' } }]);
    const executor: StepExecutor = { next: (r, s) => script.next(r, s), judge: judgeOnly.judge! };
    const report = await runTests([file], { engine: loginEngine(), timeoutMs: 2_000, agent: { executor } });
    expect(report.tests.map((t) => [t.name, t.result])).toEqual([['로그인', 'passed']]);
  });

  it('결정적 + 요소 판정: 모델 없이(실행기 없음) FakeEngine 에서 통과', async () => {
    const r = { ...session, judgments: [{ kind: 'expect' as const, query: { text: '환영합니다', exact: true }, matcher: 'visible' as const, pass: true, reason: '통과' }] };
    const file = write(exportTest(r, { style: 'deterministic', testName: '로그인', appId: 'com.example.app' }));
    const report = await runTests([file], { engine: loginEngine(), timeoutMs: 2_000, secrets: { get: (n) => (n === 'QA_PASSWORD' ? 'pw-1' : undefined) } });
    expect(report.tests.map((t) => [t.name, t.result])).toEqual([['로그인', 'passed']]);
  });
});
