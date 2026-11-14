// 가짜 usbmuxd(유닉스 소켓) + 기기 포트들. 실제 프로토콜: 16바이트 LE 헤더(길이·버전 1·메시지 8·태그) + XML plist.
// Connect 가 Result 0 을 보내면 그 소켓은 기기 포트로 가는 원시 터널이 된다(PortNumber 는 네트워크 바이트 순서 정수).
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodePlist, decodePlist, type PlistValue } from '../../src/ios/plist.ts';

export interface FakeIosDevice { deviceId: number; udid: string; connection: 'USB' | 'Network'; ports: Record<number, (socket: net.Socket) => void> }

const frame = (v: PlistValue, tag: number): Buffer => {
  const body = Buffer.from(encodePlist(v), 'utf8');
  const h = Buffer.alloc(16); h.writeUInt32LE(16 + body.length, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(8, 8); h.writeUInt32LE(tag, 12);
  return Buffer.concat([h, body]);
};
const htons = (p: number): number => ((p & 0xff) << 8) | ((p >> 8) & 0xff);

export async function startFakeUsbmuxd(devices: FakeIosDevice[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-usbmuxd-'));
  const socketPath = path.join(dir, 'usbmuxd');
  const listeners = new Set<net.Socket>();
  const attachedProps = (d: FakeIosDevice): PlistValue => ({ MessageType: 'Attached', DeviceID: d.deviceId, Properties: { DeviceID: d.deviceId, SerialNumber: d.udid, ConnectionType: d.connection, ProductID: 4776 } });
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16 && buf.length >= buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0), tag = buf.readUInt32LE(12);
        const msg = decodePlist(buf.subarray(16, len).toString('utf8')) as Record<string, PlistValue>;
        buf = buf.subarray(len);
        if (msg.MessageType === 'ListDevices') sock.write(frame({ DeviceList: devices.map(attachedProps) }, tag));
        else if (msg.MessageType === 'Listen') { listeners.add(sock); sock.write(frame({ MessageType: 'Result', Number: 0 }, tag)); for (const d of devices) sock.write(frame(attachedProps(d), 0)); }
        else if (msg.MessageType === 'Connect') {
          const d = devices.find((x) => x.deviceId === msg.DeviceID);
          const handler = d?.ports[htons(msg.PortNumber as number)];
          if (!handler) { sock.write(frame({ MessageType: 'Result', Number: 3 }, tag)); continue; } // 3 = 연결 거부
          sock.write(frame({ MessageType: 'Result', Number: 0 }, tag));
          sock.off('data', onData);
          if (buf.length) sock.unshift(buf);
          handler(sock);
          return;
        } else sock.write(frame({ MessageType: 'Result', Number: 1 }, tag));
      }
    };
    sock.on('data', onData);
    sock.on('close', () => listeners.delete(sock));
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    detach(deviceId: number): void { for (const l of listeners) l.write(frame({ MessageType: 'Detached', DeviceID: deviceId }, 0)); },
    close: () => new Promise<void>((r) => { for (const l of listeners) l.destroy(); server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); }),
  };
}

/** 가짜 lockdownd: 4바이트 BE 길이 + XML plist. 페어링 없는 GetValue 만 */
export function fakeLockdownd(values: Record<string, string>): (s: net.Socket) => void {
  return (s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        const req = decodePlist(buf.subarray(4, 4 + len).toString('utf8')) as Record<string, PlistValue>;
        buf = buf.subarray(4 + len);
        const key = req.Key as string;
        const reply: PlistValue = key in values ? { Request: 'GetValue', Key: key, Value: values[key]! } : { Request: 'GetValue', Key: key, Error: 'MissingValue' };
        const body = Buffer.from(encodePlist(reply), 'utf8');
        const h = Buffer.alloc(4); h.writeUInt32BE(body.length);
        s.write(Buffer.concat([h, body]));
      }
    });
    s.on('error', () => {});
  };
}
