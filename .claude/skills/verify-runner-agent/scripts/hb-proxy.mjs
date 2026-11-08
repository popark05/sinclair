// heartbeat 만 끊는 HTTP 프록시(네트워크 차단 흉내). 사용: node hb-proxy.mjs <target-url> <block-file> <port-file>
// <block-file> 이 있는 동안 POST /runs/:id/heartbeat 는 연결을 끊어 응답하지 않는다(에이전트는 'error' 로 본다). 다른 요청은 그대로 전달한다.
// 기동하면 OS 가 배정한 포트를 <port-file> 에 쓴다.
import http from 'node:http';
import fs from 'node:fs';

const [target, blockFile, portFile] = process.argv.slice(2);
if (!target || !blockFile || !portFile) { console.error('사용: hb-proxy.mjs <target-url> <block-file> <port-file>'); process.exit(2); }
const upstream = new URL(target);
let blocked = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && /\/runs\/[^/]+\/heartbeat$/.test(req.url ?? '') && fs.existsSync(blockFile)) {
    blocked++;
    console.log(`차단 heartbeat ${req.url} (누적 ${blocked})`);
    req.socket.destroy();
    return;
  }
  const out = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on('error', () => { res.writeHead(502).end(); });
  req.pipe(out);
});
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  fs.writeFileSync(portFile, String(typeof addr === 'object' && addr ? addr.port : ''));
  console.log(`hb-proxy → ${target} port=${typeof addr === 'object' && addr ? addr.port : '?'}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
