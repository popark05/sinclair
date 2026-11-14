// @vitest-environment node
// usbmux·lockdown 클라이언트(ios-backend 01): 기기 목록·붙음/떨어짐 알림·기기 포트 터널·호스트 포트 포워드, 페어링 없는 lockdown 값.
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import { encodePlist, decodePlist } from '../../src/ios/plist.ts';
import { createUsbmuxClient, readLockdownValues, forwardPort } from '../../src/ios/usbmux.ts';
import { startFakeUsbmuxd, fakeLockdownd } from './fake-usbmuxd.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const echo = (s: net.Socket) => s.on('data', (d: Buffer) => s.write(Buffer.from(d.toString().toUpperCase())));

describe('plist', () => {
  it('dict·array·string·integer·bool·data 를 XML plist 로 오가고, 글자는 이스케이프', () => {
    const v = { A: 'x<&>"y', N: 42, T: true, F: false, L: ['a', 1], D: Buffer.from([1, 2, 255]), Nested: { K: '한글' } };
    const back = decodePlist(encodePlist(v)) as Record<string, unknown>;
    expect({ ...back, D: Buffer.from(back.D as Uint8Array) }).toEqual({ ...v, D: Buffer.from([1, 2, 255]) });
  });
});

describe('usbmux', () => {
  async function setup() {
    const fake = await startFakeUsbmuxd([{ deviceId: 7, udid: '00008110-001A2B3C4D5E6F70', connection: 'USB', ports: { 62078: fakeLockdownd({ DeviceName: '테스트 아이폰', ProductType: 'iPhone14,5', ProductVersion: '17.5.1' }), 22087: echo } }]);
    cleanups.push(() => fake.close());
    return { fake, client: createUsbmuxClient({ socketPath: fake.socketPath }) };
  }

  it('기기 목록(USB)과 페어링 없는 lockdown 값', async () => {
    const { client } = await setup();
    expect(await client.listDevices()).toEqual([{ deviceId: 7, udid: '00008110-001A2B3C4D5E6F70', connection: 'USB' }]);
    expect(await readLockdownValues(client, 7)).toEqual({ name: '테스트 아이폰', productType: 'iPhone14,5', productVersion: '17.5.1' });
  });

  it('Connect 는 기기 포트로 가는 터널이 되고, 거부되면 사유와 함께 실패', async () => {
    const { client } = await setup();
    const s = await client.connect(7, 22087);
    cleanups.push(() => { s.destroy(); });
    const got = await new Promise<string>((r) => { s.once('data', (d: Buffer) => r(d.toString())); s.write('ping'); });
    expect(got).toBe('PING');
    await expect(client.connect(7, 9999)).rejects.toThrow(/연결 거부|9999/);
  });

  it('호스트 포트 → 기기 포트 포워드(러너 HTTP 용): 연결마다 새 터널', async () => {
    const { client } = await setup();
    const fwd = await forwardPort(client, 7, 22087);
    cleanups.push(() => fwd.close());
    for (const word of ['one', 'two']) {
      const sock = net.connect(fwd.port, '127.0.0.1');
      const got = await new Promise<string>((r) => { sock.once('data', (d: Buffer) => r(d.toString())); sock.write(word); });
      expect(got).toBe(word.toUpperCase());
      sock.destroy();
    }
  });

  it('Listen: 붙음·떨어짐 알림', async () => {
    const { fake, client } = await setup();
    const events: string[] = [];
    const stop = await client.listen((e) => events.push(`${e.type} ${e.deviceId}${e.udid ? ` ${e.udid.slice(-4)}` : ''}`));
    cleanups.push(() => stop());
    await new Promise((r) => setTimeout(r, 50));
    fake.detach(7);
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['attached 7 6F70', 'detached 7']);
  });
});
