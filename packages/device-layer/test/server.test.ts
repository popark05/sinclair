import { describe, it, expect } from 'vitest';
import { createDeviceServer, serveHttp, RPC_ERRORS } from '../src/index.ts';
import { FakeBackend } from './fake-backend.ts';

const req = (method: string, params?: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('디바이스 JSON-RPC 서버', () => {
  it('devices.list 는 모든 백엔드의 기기를 합친다', async () => {
    const d = createDeviceServer([new FakeBackend(['A']), new FakeBackend(['B'])]);
    const r = await d.handle(req('devices.list'));
    expect((r.result as unknown[]).map((x: any) => x.id)).toEqual(['A', 'B']);
  });

  it('알 수 없는 메서드와 미구현 메서드는 -32601', async () => {
    const d = createDeviceServer([new FakeBackend()]);
    expect((await d.handle(req('device.hack'))).error?.code).toBe(RPC_ERRORS.methodNotFound);
    expect((await d.handle(req('device.screenrecord'))).error?.code).toBe(RPC_ERRORS.methodNotFound);
  });

  it('없는 기기는 -32000, 빠진 파라미터는 -32602', async () => {
    const d = createDeviceServer([new FakeBackend()]);
    expect((await d.handle(req('device.io.tap', { deviceId: 'NOPE', x: 1, y: 2 }))).error?.code).toBe(RPC_ERRORS.deviceNotFound);
    expect((await d.handle(req('device.io.tap', { deviceId: 'FAKE1', x: 1 }))).error?.code).toBe(RPC_ERRORS.invalidParams);
  });

  it('같은 기기의 호출은 도착 순서대로 직렬 실행된다', async () => {
    const b = new FakeBackend();
    b.delayMs = 10;
    const d = createDeviceServer([b]);
    await Promise.all([
      d.handle(req('device.io.tap', { deviceId: 'FAKE1', x: 1, y: 1 })),
      d.handle(req('device.io.text', { deviceId: 'FAKE1', text: 'a' })),
      d.handle(req('device.io.button', { deviceId: 'FAKE1', button: 'back' })),
    ]);
    expect(b.calls).toEqual(['tap 1,1', 'text a', 'button back']);
  });

  it('dump.ui 는 @ref 를 가진 트리를 돌려준다', async () => {
    const d = createDeviceServer([new FakeBackend()]);
    const r = await d.handle(req('device.dump.ui', { deviceId: 'FAKE1' }));
    expect((r.result as any).children[0]).toMatchObject({ ref: '@e1', name: '로그인' });
  });

  it('HTTP 전송은 토큰 없이는 401, 토큰이 있으면 응답한다', async () => {
    const srv = await serveHttp(createDeviceServer([new FakeBackend()]));
    try {
      const url = `http://127.0.0.1:${srv.port}/rpc`;
      const body = JSON.stringify(req('server.info'));
      expect((await fetch(url, { method: 'POST', body })).status).toBe(401);
      const ok = await fetch(url, { method: 'POST', body, headers: { authorization: `Bearer ${srv.token}` } });
      expect(((await ok.json()) as any).result.platforms).toEqual(['android']);
    } finally { await srv.close(); }
  });
});
