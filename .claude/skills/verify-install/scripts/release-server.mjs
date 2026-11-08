// 자체 CA 로 서명된 인증서로 HTTPS 릴리스 디렉터리를 띄운다(사내 SSL 인터셉션 흉내). 동봉 Node 로 실행한다.
// 사용: node release-server.mjs <cert.pem> <key.pem> <dir>  → stdout 에 "READY port=<n>"
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
const [cert, key, dir] = process.argv.slice(2);
const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const file = path.join(dir, path.basename(req.url ?? ''));
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200).end(readFileSync(file));
});
server.listen(0, '127.0.0.1', () => console.log(`READY port=${server.address().port}`));
