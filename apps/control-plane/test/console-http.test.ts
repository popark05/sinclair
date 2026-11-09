// @vitest-environment node
// Console 을 위한 control-plane 표면: Cycle 요약 목록(GET /cycles/summary)과 Console 정적 파일 서빙(/console, --console-dir).
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemoryEventStore, serveControlPlane, parseConfig, type ControlPlaneServer } from '../src/index.ts';
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
    expect((await fetch(url('/cycles/summary?limit=0'))).status).toBe(400);
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

  it('경로 탈출(../, 인코딩된 %2e%2e)은 거부한다', async () => {
    server = await serveControlPlane(createMemoryEventStore(), { consoleDir: dir() });
    for (const p of ['/console/../secret-outside.txt', '/console/%2e%2e/secret-outside.txt', '/console/assets/%2e%2e/%2e%2e/secret-outside.txt']) {
      const r = await fetch(url(p));
      expect(await r.text()).not.toContain('nope');
    }
  });

  it('consoleDir 가 없으면 /console 은 404(API 만 있는 서버), 설정은 --console-dir·SINCLAIR_CP_CONSOLE_DIR', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    expect((await fetch(url('/console'))).status).toBe(404);
    const c = parseConfig(['--console-dir', '/opt/console'], {});
    expect(c).toMatchObject({ consoleDir: '/opt/console' });
    expect(parseConfig([], { SINCLAIR_CP_CONSOLE_DIR: '/x' })).toMatchObject({ consoleDir: '/x' });
  });
});
