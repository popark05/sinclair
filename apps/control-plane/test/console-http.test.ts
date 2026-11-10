// @vitest-environment node
// Console 을 위한 control-plane 표면: Cycle 요약 목록(GET /cycles/summary)과 Console 정적 파일 서빙(/console, --console-dir).
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createMemoryEventStore, serveControlPlane, parseConfig, resolveConsoleFile, type ControlPlaneServer } from '../src/index.ts';
import { base } from './fixtures.ts';

let server: ControlPlaneServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const url = (p: string) => `http://127.0.0.1:${server!.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: 'POST', body: JSON.stringify(body) });

describe('GET /cycles/summary', () => {
  it('최신순으로 상태·Verdict·Run 진행률(대체된 Run 제외)을 준다, limit 로 자른다', async () => {
    let t = Date.parse('2026-11-09T00:00:00Z');
    server = await serveControlPlane(createMemoryEventStore(), { now: () => t });
    await post('/cycles', { cycleId: 'old', build: '1.0', targets: ['android'] });
    await new Promise((r) => setTimeout(r, 5));
    await post('/cycles', { cycleId: 'new', build: '1.1', targets: ['android', 'ios'] });
    await post('/cycles/new/runs', { targetId: 'android', runId: 'r1' });
    await post('/cycles/new/runs', { targetId: 'ios', runId: 'r2' });
    const ing = await post('/ingest', [
      { ...base('a', 1), runId: 'r1', type: 'run.started', cycleId: 'new', targetId: 'android' },
      { ...base('b', 2), runId: 'r1', type: 'attempt.started', attemptId: 'x', testId: '로그인', attemptNo: 1 },
      { ...base('c', 3), runId: 'r1', type: 'attempt.finished', attemptId: 'x', result: 'passed', artifacts: [] },
      { ...base('d', 4), runId: 'r1', type: 'run.finished', state: 'finished' },
    ]);
    expect(ing.status).toBe(200);
    t += 1000;
    const res = await fetch(url('/cycles/summary'));
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list.map((c) => c.cycleId)).toEqual(['new', 'old']);
    expect(list[0]).toMatchObject({ cycleId: 'new', build: '1.1', targets: ['android', 'ios'], state: 'running', runs: { total: 2, finished: 1 } });
    expect(list[0]).toHaveProperty('verdict');
    expect(list[1]).toMatchObject({ cycleId: 'old', runs: { total: 0, finished: 0 } });
    expect(((await (await fetch(url('/cycles/summary?limit=1'))).json()) as unknown[]).length).toBe(1);
    // lease 없이 보고된 Run(sinclair-agent run)도 노드·기기가 Cycle 의 Run 행에 보인다(이벤트의 run.started 에서)
    await post('/ingest', [{ ...base('s1', 5), runId: 'r2', type: 'run.started', cycleId: 'new', targetId: 'ios', agentId: 'node-9', deviceId: 'SERIAL9' }]);
    const view = (await (await fetch(url('/cycles/new'))).json()) as { runs: Array<{ runId: string; agentId?: string; deviceId?: string }> };
    expect(view.runs.find((r) => r.runId === 'r2')).toMatchObject({ agentId: 'node-9', deviceId: 'SERIAL9' });
    expect((await fetch(url('/cycles/summary?limit=0'))).status).toBe(400);
    expect((await fetch(url('/cycles/summary?limit=101'))).status).toBe(400); // 상한 100: Cycle 마다 이벤트를 읽는다
    // 예약어: summary 라는 cycleId 는 만들 수 없다(GET /cycles/summary 와 겹친다)
    expect((await post('/cycles', { cycleId: 'summary', build: 'b', targets: ['a'] })).status).toBe(400);
  });
});

describe('Console 정적 서빙', () => {
  const dir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-console-'));
    fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.mkdirSync(path.join(d, 'assets'));
    fs.writeFileSync(path.join(d, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(d, 'assets', 'app.css'), 'body{}');
    fs.writeFileSync(path.join(path.dirname(d), 'secret-outside.txt'), 'nope');
    return d;
  };

  it('/console 은 index.html, 자산은 MIME 과 함께, SPA 경로는 index.html, 없는 자산은 404, / 는 /console/ 로', async () => {
    server = await serveControlPlane(createMemoryEventStore(), { consoleDir: dir() });
    const index = await fetch(url('/console'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect(await index.text()).toContain('id="root"');
    expect((await fetch(url('/console/assets/app.js'))).headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(url('/console/assets/app.css'))).headers.get('content-type')).toMatch(/text\/css/);
    const spa = await fetch(url('/console/cycles/c1'));
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('id="root"');
    expect((await fetch(url('/console/assets/missing.js'))).status).toBe(404);
    const root = await fetch(url('/'), { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/console/');
  });

  it('경로 탈출: 정규화되지 않은 원시 요청(%2f·%5c·..)으로도 밖의 파일을 주지 않는다; 해석기는 Windows 구분자도 막는다', async () => {
    server = await serveControlPlane(createMemoryEventStore(), { consoleDir: dir() });
    // fetch 는 ../ 를 미리 정규화하므로 원시 HTTP 로 보낸다
    const raw = (p: string) => new Promise<string>((resolve) => { http.get({ host: '127.0.0.1', port: server!.port, path: p }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve(t)); }); });
    for (const p of ['/console/../secret-outside.txt', '/console/..%2fsecret-outside.txt', '/console/assets/..%2f..%2fsecret-outside.txt', '/console/..%5csecret-outside.txt']) expect(await raw(p)).not.toContain('nope');
    const nodePath = await import('node:path');
    expect(resolveConsoleFile('C:\\console', '/..\\..\\secret', nodePath.win32)).toBeUndefined();
    expect(resolveConsoleFile('/srv/console', '/../../etc/passwd', nodePath.posix)).toBeUndefined(); // .. 조각은 아예 받지 않는다
    expect(resolveConsoleFile('/srv/console', '/assets/app.js', nodePath.posix)).toBe('/srv/console/assets/app.js');
  });

  it('점이 든 경로(app-1.2.3 같은 Cycle id)도 화면이면 index.html, 실제 파일만 자산, assets/ 아래 없는 파일은 404; HEAD 도 된다', async () => {
    server = await serveControlPlane(createMemoryEventStore(), { consoleDir: dir() });
    for (const p of ['/console/cycles/app-1.2.3', '/console/cycles/x/cases/login/ios-17.4', '/console/runs/run.1']) {
      const r = await fetch(url(p));
      expect(r.status, p).toBe(200);
      expect(await r.text()).toContain('id="root"');
    }
    expect((await fetch(url('/console/assets/missing.js'))).status).toBe(404);
    const head = await fetch(url('/console/assets/app.js'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(url('/console/'), { method: 'HEAD' })).status).toBe(200);
  });

  it('consoleDir 가 없으면 /console 은 404(API 만 있는 서버), 설정은 --console-dir·SINCLAIR_CP_CONSOLE_DIR', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    expect((await fetch(url('/console'))).status).toBe(404);
    const given = dir();
    expect(parseConfig(['--console-dir', given], {})).toMatchObject({ consoleDir: path.resolve(given) });
    expect(parseConfig([], { SINCLAIR_CP_CONSOLE_DIR: given })).toMatchObject({ consoleDir: path.resolve(given) });
    // 직접 준 디렉터리에 index.html 이 없으면 조용히 404 만 내지 않고 기동 때 설정 오류
    expect(() => parseConfig(['--console-dir', path.join(given, 'assets')], {})).toThrow(/index\.html/);
    // 설치본: 자산 디렉터리(SINCLAIR_RESOURCES_DIR, 기본은 번들 옆 resources/)에 console/index.html 이 있으면 기본으로, none 이면 끈다
    const res = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-res-'));
    fs.mkdirSync(path.join(res, 'console'));
    fs.writeFileSync(path.join(res, 'console', 'index.html'), 'x');
    expect(parseConfig([], { SINCLAIR_RESOURCES_DIR: res })).toMatchObject({ consoleDir: path.join(res, 'console') });
    expect(parseConfig(['--console-dir', 'none'], { SINCLAIR_RESOURCES_DIR: res })).not.toHaveProperty('consoleDir');
    expect(parseConfig([], { SINCLAIR_RESOURCES_DIR: path.join(res, 'nope') })).not.toHaveProperty('consoleDir');
  });
});
