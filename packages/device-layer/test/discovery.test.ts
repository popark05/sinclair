// @vitest-environment node
// 디바이스 RPC 발견 파일(studio 02): 데몬이 로컬 디바이스 RPC(127.0.0.1·토큰)를 열면 포트·토큰·pid 를 남기고, Studio 가 읽어 붙는다(USB 를 다투지 않게).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishDeviceRpc, readDeviceRpc, unpublishDeviceRpc, defaultDiscoveryFile } from '../src/index.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-disc-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('디바이스 RPC 발견 파일', () => {
  it('쓰고(0600) 읽는다: 살아 있는 pid 면 정보, 죽은 pid 면 undefined', async () => {
    const file = path.join(dir, 'sub', 'device-rpc.json');
    await publishDeviceRpc(file, { port: 4321, token: 'tok', pid: process.pid, agentId: 'node-1' });
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(await readDeviceRpc(file)).toMatchObject({ port: 4321, token: 'tok', pid: process.pid, agentId: 'node-1', startedAt: expect.any(String) });
    await publishDeviceRpc(file, { port: 4321, token: 'tok', pid: 2 ** 22 + 12345 });
    expect(await readDeviceRpc(file)).toBeUndefined();
  });

  it('없거나 깨진 파일은 undefined, 지우기는 내 pid 의 파일만', async () => {
    const file = path.join(dir, 'device-rpc.json');
    expect(await readDeviceRpc(file)).toBeUndefined();
    fs.writeFileSync(file, '{"port":"x"}');
    expect(await readDeviceRpc(file)).toBeUndefined();
    await publishDeviceRpc(file, { port: 1, token: 't', pid: process.pid });
    await unpublishDeviceRpc(file, process.pid + 1);
    expect(fs.existsSync(file)).toBe(true);
    await unpublishDeviceRpc(file, process.pid);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('기본 위치는 OS 데이터 디렉터리/sinclair/device-rpc.json', () => {
    expect(defaultDiscoveryFile({ HOME: '/Users/qa' }, 'darwin')).toBe('/Users/qa/Library/Application Support/sinclair/device-rpc.json');
    expect(defaultDiscoveryFile({ HOME: '/home/qa' }, 'linux')).toBe('/home/qa/.local/share/sinclair/device-rpc.json');
  });
});
