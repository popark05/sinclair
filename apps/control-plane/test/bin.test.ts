// @vitest-environment node
// 자식 프로세스로 실제 bin 을 띄운다: READY 로그, /health, ingest → SIGTERM → 재기동 → sqlite 는 유지, memory 는 소실, 스키마 불일치는 거부.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUN } from './fixtures.ts';

const BIN = path.resolve(import.meta.dirname, '../bin/sinclair-control-plane.mjs');
const children: ChildProcess[] = [];
afterEach(() => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); children.length = 0; });

/** bin 을 띄우고 READY 줄의 포트를 돌려준다. 종료하면 코드와 출력을 준다 */
function start(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  // READY 를 기다리지 않는 호출자(종료 코드만 보는 테스트)가 있으니 거부는 await 할 때만 만든다
  const ready = () => new Promise<number>((resolve, reject) => {
    const check = () => { const m = /READY .*port=(\d+)/.exec(out); if (m) resolve(Number(m[1])); };
    check();
    child.stdout!.on('data', check);
    void exited.then((code) => reject(new Error(`READY 전에 종료됨(code ${code}): ${out}`)));
    setTimeout(() => reject(new Error(`READY 대기 시간 초과: ${out}`)), 15_000).unref(); // 셸 재실행 + TS 변환 로드가 느린 CI 에서도 넉넉히
  });
  return { child, ready, exited, output: () => out, stop: async () => { child.kill('SIGTERM'); return exited; } };
}

describe('sinclair-control-plane bin', () => {
  it('sqlite: READY 로그에 저장소·DB·스키마가 찍히고, SIGTERM 으로 정상 종료 뒤 같은 DB 로 다시 띄우면 run 이 남아 있다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-bin-'));
    const db = path.join(dir, 'nested', 'cp.db');
    try {
      const a = start(['--port', '0', '--db', db]);
      const port = await a.ready();
      expect(a.output()).toMatch(/store=sqlite db=.*cp\.db schema=\d+/);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: JSON.stringify(RUN) });
      const view = await (await fetch(`http://127.0.0.1:${port}/runs/r1`)).text();
      expect(await a.stop()).toBe(0);
      expect(a.output()).toContain('SIGTERM 수신');
      expect(a.output()).toContain('종료 완료');

      const b = start(['--port=0'], { SINCLAIR_CP_DB: db }); // 환경변수로도 같은 DB
      const port2 = await b.ready();
      expect(await (await fetch(`http://127.0.0.1:${port2}/runs/r1`)).text()).toBe(view);
      expect(await b.stop()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memory: 재기동하면 사라진다', async () => {
    const a = start(['--port', '0', '--store', 'memory']);
    const port = await a.ready();
    expect(a.output()).toMatch(/store=memory/);
    await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: JSON.stringify(RUN) });
    expect((await fetch(`http://127.0.0.1:${port}/runs/r1`)).status).toBe(200);
    await a.stop();
    const b = start(['--port', '0', '--store', 'memory']);
    expect((await fetch(`http://127.0.0.1:${await b.ready()}/runs/r1`)).status).toBe(404);
    await b.stop();
  });

  it('설정 오류와 스키마 버전 불일치는 종료 코드 2 와 한국어 메시지', async () => {
    const bad = start(['--store', 'postgres']);
    expect(await bad.exited).toBe(2);
    expect(bad.output()).toMatch(/설정 오류: store/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-bin-'));
    try {
      const db = path.join(dir, 'future.db');
      const raw = new DatabaseSync(db); raw.exec('PRAGMA user_version = 99'); raw.close();
      const future = start(['--port', '0', '--db', db]);
      expect(await future.exited).toBe(2);
      expect(future.output()).toMatch(/기동 실패: .*스키마 버전 99/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('쓸 수 없는 디렉터리의 DB 는 기동 실패 코드 2 다', async () => {
    if (process.getuid?.() === 0) return; // root 는 권한 검사를 통과한다
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-bin-'));
    try {
      fs.chmodSync(dir, 0o500);
      const locked = start(['--port', '0', '--db', path.join(dir, 'sub', 'cp.db')]);
      expect(await locked.exited).toBe(2);
      expect(locked.output()).toMatch(/기동 실패: /);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--help 는 도움말을 내고 0 으로 끝난다', async () => {
    const h = start(['--help']);
    expect(await h.exited).toBe(0);
    expect(h.output()).toContain('사용법: sinclair-control-plane');
  });
});
