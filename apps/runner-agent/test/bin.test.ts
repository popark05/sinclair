// @vitest-environment node
// 스모크: 실제 bin 두 개(control-plane, agent)를 자식 프로세스로 띄워 `sinclair-agent run --engine fake` 가 0 으로 끝나고 Cycle 이 채워진다.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const CP_BIN = path.resolve(import.meta.dirname, '../../control-plane/bin/sinclair-control-plane.mjs');
const AGENT_BIN = path.resolve(import.meta.dirname, '../bin/sinclair-agent.mjs');
const children: ChildProcess[] = [];
afterEach(() => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); children.length = 0; });

function spawnBin(bin: string, args: string[]) {
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; }); child.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, output: () => out };
}

describe('sinclair-agent bin', { timeout: 30_000 }, () => {
  it('run --engine fake 가 Run 을 등록·실행·보고하고 0 으로 끝난다', async () => {
    const cp = spawnBin(CP_BIN, ['--port', '0', '--store', 'memory']);
    const port = await new Promise<number>((resolve, reject) => {
      const check = () => { const m = /READY .*port=(\d+)/.exec(cp.output()); if (m) resolve(Number(m[1])); };
      cp.child.stdout!.on('data', check);
      setTimeout(() => reject(new Error(`control-plane READY 시간 초과: ${cp.output()}`)), 15_000).unref(); // 셸 재실행 + TS 로드 여유
    });
    const url = `http://127.0.0.1:${port}`;
    await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'smoke', build: 'b', targets: ['android'] }) });

    const agent = spawnBin(AGENT_BIN, ['run', '--control-plane', url, '--cycle', 'smoke', '--target', 'android', '--tests', path.resolve(import.meta.dirname, 'fixtures/only-login'), '--engine', 'fake']);
    expect(await agent.exited).toBe(0);
    expect(agent.output()).toMatch(/passed 1, failed 0/);
    const view = (await (await fetch(`${url}/cycles/smoke`)).json()) as { state: string; verdict: string };
    expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });

    const bad = spawnBin(AGENT_BIN, ['run', '--cycle', 'smoke']);
    expect(await bad.exited).toBe(3);
    expect(bad.output()).toMatch(/설정 오류: --control-plane/);
    const help = spawnBin(AGENT_BIN, ['run', '--help']);
    expect(await help.exited).toBe(0);
    expect(help.output()).toContain('사용법: sinclair-agent run');
    cp.child.kill('SIGTERM');
    await cp.exited;
  }); // 셸 재실행 bin 4개(control-plane 1 + agent 3) × TS 변환 로드: describe 수준 30초
});
