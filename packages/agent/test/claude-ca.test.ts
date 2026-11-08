// 사내망(SSL 인터셉션) 흉내: openssl 자체 CA 로 서명한 HTTPS 가짜 Messages API. NODE_EXTRA_CA_CERTS 없이는 연결 실패(사유에 변수 이름), 있으면 호출된다.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const child = path.join(import.meta.dirname, 'fixtures', 'ca-call.ts');

describe.skipIf(!hasOpenssl)('Claude 실행기 · 사내망 CA(NODE_EXTRA_CA_CERTS)', () => {
  let dir: string;
  let server: https.Server;
  let baseURL: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-ca-'));
    const o = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Sinclair Test CA', '-keyout', 'ca.key', '-out', 'ca.pem']);
    o(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', 'srv.key', '-out', 'srv.csr']);
    fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\n');
    o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.cnf', '-out', 'srv.pem']);
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'srv.key')), cert: fs.readFileSync(path.join(dir, 'srv.pem')) }, (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't', name: 'done', input: { summary: 'ok' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const call = async (extraCa?: string): Promise<{ ok: boolean; reason?: string }> => {
    const env: NodeJS.ProcessEnv = { ...process.env, CA_TEST_BASE_URL: baseURL };
    delete env.NODE_EXTRA_CA_CERTS;
    if (extraCa) env.NODE_EXTRA_CA_CERTS = extraCa;
    // 비동기 spawn: 같은 프로세스의 HTTPS 서버가 응답할 수 있게 이벤트 루프를 막지 않는다
    const { spawn } = await import('node:child_process');
    const p = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', child], { env, cwd: path.join(import.meta.dirname, '..') });
    let out = ''; let err = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    const code = await new Promise<number | null>((r) => p.on('close', r));
    if (code !== 0) throw new Error(`자식 실패(${code}): ${err}`);
    return JSON.parse(out.trim().split('\n').at(-1)!) as { ok: boolean; reason?: string };
  };

  it('CA 없이는 연결 실패이고 사유가 NODE_EXTRA_CA_CERTS 를 가리킨다, CA 를 주면 호출이 끝난다', async () => {
    expect(await call()).toMatchObject({ ok: false, reason: expect.stringMatching(/연결하지 못함.*NODE_EXTRA_CA_CERTS/) });
    expect(await call(path.join(dir, 'ca.pem'))).toEqual({ ok: true });
  }, 30_000);
});
