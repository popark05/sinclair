// @vitest-environment node
// iOS 러너 HTTP 클라이언트(ios-backend 02): Bearer 토큰, /ping·/dump·/snapshot·/action·/app — 좌표는 픽셀 → 포인트(배율)로 보낸다.
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IosRunnerClient } from '../../src/ios/runner-client.ts';

let server: http.Server | undefined;
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(undefined))); server = undefined; });

async function fakeRunner(token: string) {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: '토큰' });
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, path: req.url!, body });
      const tree = { type: 'Application', frame: { x: 0, y: 0, width: 414, height: 896 }, enabled: true, selected: false, children: [{ type: 'Button', label: 'OK', frame: { x: 10, y: 10, width: 100, height: 44 }, enabled: true, selected: false, children: [] }] };
      if (req.url === '/ping') return send(200, { ok: true, version: '0.1.0', iosVersion: '17.6.1', model: 'iPhone11,6', screen: { width: 414, height: 896 }, scale: 3 });
      if (req.url?.startsWith('/dump')) return send(200, { root: tree });
      if (req.url === '/snapshot') return send(200, { root: tree, screenshot: Buffer.from('PNG').toString('base64') });
      if (req.url === '/app/foreground') return send(200, { bundleId: 'com.apple.Preferences' });
      if (req.method === 'POST') return send(200, { ok: true });
      return send(404, { error: 'x' });
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { port: (server!.address() as AddressInfo).port, seen };
}

describe('IosRunnerClient', () => {
  it('ping 으로 배율을 알고, 트리는 SemanticNode(픽셀), 입력 좌표는 포인트로 보낸다', async () => {
    const f = await fakeRunner('tok');
    const c = new IosRunnerClient(f.port, 'tok');
    expect(await c.ping()).toMatchObject({ model: 'iPhone11,6', scale: 3 });
    const root = await c.dump();
    expect(root).toMatchObject({ role: 'root', rect: { width: 1242, height: 2688 }, children: [{ role: 'button', name: 'OK', rect: { x: 30, y: 30 } }] });
    const snap = await c.snapshot();
    expect(snap).toMatchObject({ atomic: true, screenshot: { format: 'png', base64: Buffer.from('PNG').toString('base64') } });
    await c.tap({ x: 300, y: 600 });
    await c.swipe({ x: 540, y: 2000 }, { x: 540, y: 600 }, 300);
    await c.type('안녕');
    await c.app('launch', 'com.apple.Preferences');
    expect(await c.foreground()).toBe('com.apple.Preferences');
    const posts = f.seen.filter((s) => s.method === 'POST');
    expect(posts).toEqual([
      { method: 'POST', path: '/action', body: { action: 'tap', x: 100, y: 200 } },
      { method: 'POST', path: '/action', body: { action: 'swipe', fromX: 180, fromY: 666.67, toX: 180, toY: 200, durationMs: 300 } },
      { method: 'POST', path: '/action', body: { action: 'type', text: '안녕' } },
      { method: 'POST', path: '/app', body: { action: 'launch', bundleId: 'com.apple.Preferences' } },
    ]);
  });

  it('토큰이 틀리면 HTTP 401 오류', async () => {
    const f = await fakeRunner('tok');
    await expect(new IosRunnerClient(f.port, 'wrong').ping()).rejects.toThrow(/401/);
  });
});
