// @vitest-environment node
// 작업 프로세스(ADR 0005): 메인이 plain Node 로 띄우고 IPC ping 왕복, 상태(starting → ready → exited), 죽으면 대기 중 요청이 실패한다.
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { createWorkerHost, resolveWorkerNode, type WorkerHost } from '../src/main/worker-host.ts';
import type { WorkerStatus } from '../src/shared/studio-ipc.ts';

const SCRIPT = path.resolve(import.meta.dirname, '../src/worker/index.ts');
let host: WorkerHost | undefined;
afterEach(async () => { await host?.stop(); host = undefined; });

describe('createWorkerHost', () => {
  it('plain Node 작업 프로세스를 띄워 ready 가 되고 ping 이 그 Node 버전과 함께 돌아온다', async () => {
    const seen: WorkerStatus['state'][] = [];
    host = createWorkerHost({ node: process.execPath, script: SCRIPT, onStatus: (s) => seen.push(s.state) });
    await host.ready();
    const r = await host.ping();
    expect(r.node).toBe(process.version);
    expect(r.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(seen.slice(0, 2)).toEqual(['starting', 'ready']);
    expect(host.status()).toMatchObject({ state: 'ready', node: process.version });
  });

  it('작업 프로세스가 죽으면 exited 이고, 대기 중이던 ping 은 실패한다', async () => {
    host = createWorkerHost({ node: process.execPath, script: SCRIPT });
    await host.ready();
    const pending = host.ping({ delayMs: 500 });
    host.kill();
    await expect(pending).rejects.toThrow(/작업 프로세스/);
    expect(host.status().state).toBe('exited');
  });

  it('Node 를 찾지 못하면 starting 뒤 exited(오류)', async () => {
    host = createWorkerHost({ node: '/no/such/node', script: SCRIPT });
    await expect(host.ready()).rejects.toThrow();
    expect(host.status()).toMatchObject({ state: 'exited', error: expect.any(String) });
  });
});

describe('resolveWorkerNode', () => {
  it('SINCLAIR_STUDIO_NODE 가 있으면 그것, 없으면 PATH 의 node', () => {
    expect(resolveWorkerNode({ SINCLAIR_STUDIO_NODE: '/opt/node' })).toBe('/opt/node');
    expect(resolveWorkerNode({})).toBe('node');
  });
});
