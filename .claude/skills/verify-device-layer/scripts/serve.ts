// 검증용 스캐폴딩: 디바이스 JSON-RPC 서버를 페이크 백엔드로 띄운다. 실제 기기가 없어도 서버 계약을 구동할 수 있다.
// 사용: node scripts/serve.ts <RUN_DIR>   (RUN_DIR 에 server.json, backend-calls.log 를 쓴다)
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDeviceServer, serveHttp, type DeviceBackend, type DeviceInfo, type Point } from '../../../../packages/device-layer/src/index.ts';

const runDir = process.argv[2];
if (!runDir) { console.error('사용법: node scripts/serve.ts <RUN_DIR>'); process.exit(2); }
mkdirSync(runDir, { recursive: true });
const callLog = join(runDir, 'backend-calls.log');
writeFileSync(callLog, '');

/** 백엔드 호출을 한 줄씩 파일에 남겨 부수효과를 증거로 남긴다 */
class LoggingFakeBackend implements DeviceBackend {
  readonly platform = 'android' as const;
  private readonly ids: string[];
  constructor(ids: string[]) { this.ids = ids; }
  private log(id: string, line: string) { appendFileSync(callLog, `${new Date().toISOString()} ${id} ${line}\n`); }
  async listDevices(): Promise<DeviceInfo[]> {
    return this.ids.map((id) => ({ id, platform: 'android', model: 'VerifyFake', osVersion: '14', state: 'device' }));
  }
  async info(id: string) { return (await this.listDevices()).find((d) => d.id === id)!; }
  async screenshot() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); }
  async dumpUi() {
    return { ref: '@e0', role: 'root', children: [
      { ref: '@e1', role: 'button', name: '로그인' },
      { ref: '@e2', role: 'textbox', name: '아이디' },
    ] };
  }
  async tap(id: string, p: Point) { this.log(id, `tap ${p.x},${p.y}`); }
  async longPress(id: string, p: Point, d: number) { this.log(id, `longpress ${p.x},${p.y} ${d}`); }
  async swipe(id: string, a: Point, b: Point, d: number) { this.log(id, `swipe ${a.x},${a.y}->${b.x},${b.y} ${d}`); }
  async text(id: string, t: string) { this.log(id, `text ${t}`); }
  async keys(id: string, k: string[]) { this.log(id, `keys ${k.join('+')}`); }
  async button(id: string, b: string) { this.log(id, `button ${b}`); }
  async launchApp(id: string, a: string) { this.log(id, `launch ${a}`); }
  async terminateApp(id: string, a: string) { this.log(id, `terminate ${a}`); }
  async openUrl(id: string, u: string) { this.log(id, `url ${u}`); }
}

const srv = await serveHttp(createDeviceServer([new LoggingFakeBackend(['VERIFY1', 'VERIFY2'])]));
writeFileSync(join(runDir, 'server.json'), JSON.stringify({ port: srv.port, token: srv.token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
console.log(`READY port=${srv.port} runDir=${runDir}`);
const stop = async () => { await srv.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
