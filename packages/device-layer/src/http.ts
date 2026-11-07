// HTTP 전송: POST /rpc 에 JSON-RPC 본문. 127.0.0.1 에만 바인딩하고 토큰을 요구한다.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RpcDispatcher } from './rpc.ts';
import { RPC_ERRORS } from './rpc.ts';

export interface HttpServerOptions { port?: number; token?: string }

export async function serveHttp(dispatcher: RpcDispatcher, opts: HttpServerOptions = {}) {
  const token = opts.token ?? randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { body = null; }
    const response = body === null
      ? { jsonrpc: '2.0', id: 0, error: { code: RPC_ERRORS.parse, message: 'JSON 파싱 실패' } }
      : await dispatcher.handle(body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, token, close: () => new Promise<void>((r) => server.close(() => r())) };
}
