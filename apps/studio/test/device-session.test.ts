// @vitest-environment node
// Studio 작업 프로세스의 기기 연결(studio 02, ADR 0005): 살아 있는 데몬의 디바이스 RPC 가 있으면 거기 붙고, 없으면 직접 연다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDeviceServer, publishDeviceRpc, serveHttp, type DeviceBackend } from '@sinclair/device-layer';
import { rpcOverDispatcher } from '@sinclair/engine-mobile';
import { connectDevices } from '../src/worker/device-session.ts';

const fakeBackend = (id: string, model: string): DeviceBackend => ({
  platform: 'android',
  listDevices: async () => [{ id, platform: 'android', model, osVersion: '13', state: 'device', helper: { state: 'ready', version: '0.1.0' } }],
  info: async () => ({ id, platform: 'android', model, osVersion: '13', state: 'device', helper: { state: 'ready', version: '0.1.0' } }),
}) as unknown as DeviceBackend;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-studio-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('connectDevices', () => {
  it('발견 파일의 데몬이 살아 있고 응답하면 데몬 RPC 에 붙는다(직접 열지 않음)', async () => {
    const server = await serveHttp(createDeviceServer([fakeBackend('DAEMON0001', 'SM-N981N')]));
    const file = path.join(dir, 'device-rpc.json');
    await publishDeviceRpc(file, { port: server.port, token: server.token, pid: process.pid, agentId: 'node-1' });
    let opened = 0;
    const c = await connectDevices({ discoveryFile: file, openOwn: async () => { opened++; throw new Error('열면 안 됨'); } });
    expect(c.connection).toMatchObject({ mode: 'daemon', detail: expect.stringMatching(/node-1/) });
    expect((await c.listDevices()).map((d) => [d.id, d.model])).toEqual([['DAEMON0001', 'SM-N981N']]);
    expect(opened).toBe(0);
    await c.close();
    await server.close();
  });

  it('발견 파일이 없거나 데몬이 응답하지 않으면 직접 연다', async () => {
    const file = path.join(dir, 'device-rpc.json');
    await publishDeviceRpc(file, { port: 1, token: 't', pid: process.pid }); // 살아 있는 pid 지만 포트가 닫혀 있다
    let closed = 0;
    const c = await connectDevices({ discoveryFile: file, probeTimeoutMs: 500, openOwn: async () => ({ rpc: rpcOverDispatcher(createDeviceServer([fakeBackend('OWN0000002', 'Pixel 7')])), close: async () => { closed++; } }) });
    expect(c.connection).toMatchObject({ mode: 'own' });
    expect((await c.listDevices()).map((d) => d.id)).toEqual(['OWN0000002']);
    await c.close();
    expect(closed).toBe(1);
  });

  it('직접 열기도 실패하면 none 과 사유(기기 목록은 빈 배열)', async () => {
    const c = await connectDevices({ discoveryFile: path.join(dir, 'none.json'), openOwn: async () => { throw new Error('USB 를 열 수 없음'); } });
    expect(c.connection).toEqual({ mode: 'none', detail: expect.stringMatching(/USB 를 열 수 없음/) });
    expect(await c.listDevices()).toEqual([]);
  });
});
