import type { DeviceBackend, DeviceInfo, Point } from '../src/backend.ts';

/** 호출을 기록하는 페이크. 지연을 주입해 직렬화를 검증할 수 있다 */
export class FakeBackend implements DeviceBackend {
  readonly platform = 'android' as const;
  readonly calls: string[] = [];
  delayMs = 0;
  constructor(private readonly ids: string[] = ['FAKE1']) {}
  private async rec(s: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.calls.push(s);
  }
  async listDevices(): Promise<DeviceInfo[]> {
    return this.ids.map((id) => ({ id, platform: 'android', model: 'Fake', osVersion: '14', state: 'device' }));
  }
  async info(id: string) { return (await this.listDevices()).find((d) => d.id === id)!; }
  async screenshot() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  async dumpUi() { return { ref: '@e0', role: 'root', children: [{ ref: '@e1', role: 'button', name: '로그인' }] }; }
  async tap(_: string, p: Point) { await this.rec(`tap ${p.x},${p.y}`); }
  async longPress(_: string, p: Point, d: number) { await this.rec(`longpress ${p.x},${p.y} ${d}`); }
  async swipe(_: string, a: Point, b: Point) { await this.rec(`swipe ${a.x},${a.y}->${b.x},${b.y}`); }
  async text(_: string, t: string) { await this.rec(`text ${t}`); }
  async keys(_: string, k: string[]) { await this.rec(`keys ${k.join('+')}`); }
  async button(_: string, b: string) { await this.rec(`button ${b}`); }
  async launchApp(_: string, a: string) { await this.rec(`launch ${a}`); }
  async terminateApp(_: string, a: string) { await this.rec(`terminate ${a}`); }
  async openUrl(_: string, u: string) { await this.rec(`url ${u}`); }
}
