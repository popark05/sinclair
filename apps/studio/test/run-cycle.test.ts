// @vitest-environment node
// Cycle 로 실행(studio-console 04): 내보낸 테스트를 테스트 폴더/<이름>/ 에 쓰고, 고른 기기(deviceId 조건)를 타깃으로 Cycle·Run 을 등록한다 — 같은 머신의 데몬이 돌린다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type RunningControlPlane } from '@sinclair/control-plane';
import { runAsCycle, cycleStatus, testSlug } from '../src/worker/run-cycle.ts';
import { isConsoleUrl } from '../src/shared/console-link.ts';

let cp: RunningControlPlane;
let url: string;
let testsDir: string;
beforeEach(async () => { cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused' }); url = `http://127.0.0.1:${cp.server.port}`; testsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tests-')); });
afterEach(async () => { await cp.close(); fs.rmSync(testsDir, { recursive: true, force: true }); });

const code = "import { test } from '@sinclair/runner';\ntest('YouTube 검색', async () => {});\n";

describe('runAsCycle', () => {
  it('테스트 폴더/<이름>/<이름>.sinclair.ts 에 쓰고, 그 폴더를 suite 로 deviceId 타깃 Cycle 과 Run 을 등록한다', async () => {
    const r = await runAsCycle({ controlPlane: url, testsDir, testName: 'YouTube 검색', code, deviceId: 'R3CN30ABCDXLZW', deviceLabel: 'SM-N981N (…XLZW)' });
    const file = path.join(testsDir, 'YouTube 검색', 'YouTube 검색.sinclair.ts');
    expect(fs.readFileSync(file, 'utf8')).toBe(code);
    expect(r).toMatchObject({ cycleId: expect.stringMatching(/^studio-/), consoleUrl: `${url}/console/cycles/${r.cycleId}` });
    const view = await (await fetch(`${url}/cycles/${r.cycleId}`)).json() as { targetSelectors: Record<string, { deviceId: string }>; suite: { tests: string }; runs: Array<{ state: string }> };
    expect(Object.values(view.targetSelectors)).toEqual([{ id: 'SM-N981N (…XLZW)', platform: 'android', deviceId: 'R3CN30ABCDXLZW' }]);
    expect(view.suite.tests).toBe(path.dirname(file));
    expect(view.runs).toEqual([expect.objectContaining({ state: 'queued' })]);
    expect(await cycleStatus({ controlPlane: url, cycleId: r.cycleId })).toMatchObject({ state: 'running', verdict: 'incomplete', runState: 'queued' });
  });

  it('이름은 파일 이름으로 안전하게(경로 구분자·상위 경로 없음), 결과 경로는 늘 테스트 폴더 안', () => {
    expect(testSlug('a/b\\\\c:d')).toBe('a b c d');
    expect(testSlug('../../etc')).toBe('etc');
    expect(testSlug('   ')).toBe('studio-test');
  });
});

describe('isConsoleUrl', () => {
  it('설정의 control-plane 아래 /console/ 주소만(다른 호스트·스킴은 거부)', () => {
    expect(isConsoleUrl('http://127.0.0.1:4780/console/cycles/x', 'http://127.0.0.1:4780')).toBe(true);
    expect(isConsoleUrl('http://evil.example/console/cycles/x', 'http://127.0.0.1:4780')).toBe(false);
    expect(isConsoleUrl('file:///etc/passwd', 'http://127.0.0.1:4780')).toBe(false);
    expect(isConsoleUrl('http://127.0.0.1:4780/cycles/x', 'http://127.0.0.1:4780')).toBe(false);
  });
});
