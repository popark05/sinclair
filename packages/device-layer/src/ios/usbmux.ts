// usbmux·lockdown 클라이언트(ios-backend 01): usbmuxd(macOS /var/run/usbmuxd, Windows 127.0.0.1:27015)의 plist 프로토콜.
// ListDevices·Listen(붙음·떨어짐)·Connect(기기 id·포트 → 그 소켓이 그대로 원시 터널). lockdownd(62078)는 페어링 없는 GetValue 만(이름·모델·iOS 버전).
import * as net from 'node:net';
import { encodePlist, decodePlist, type PlistValue } from './plist.ts';

export interface UsbmuxDevice { deviceId: number; udid: string; connection: 'USB' | 'Network' }
export type UsbmuxEvent = { type: 'attached'; deviceId: number; udid: string; connection: 'USB' | 'Network' } | { type: 'detached'; deviceId: number; udid?: undefined };
export interface UsbmuxClient {
  listDevices(): Promise<UsbmuxDevice[]>;
  /** 기기 포트로 가는 원시 터널 소켓 */
  connect(deviceId: number, port: number): Promise<net.Socket>;
  /** 붙음·떨어짐 알림을 받는다. 돌려준 함수로 끊는다 */
  listen(onEvent: (e: UsbmuxEvent) => void): Promise<() => void>;
}
export interface UsbmuxOptions { socketPath?: string; timeoutMs?: number }

const LOCKDOWN_PORT = 62078;
const RESULT_TEXT: Record<number, string> = { 1: '잘못된 요청', 2: '기기 없음', 3: '연결 거부(그 포트를 기기에서 듣지 않음)', 6: '잘못된 버전' };
const defaultEndpoint = (): net.NetConnectOpts => (process.platform === 'win32' ? { host: '127.0.0.1', port: 27015 } : { path: '/var/run/usbmuxd' });

/** usbmuxd 와 한 번 대화하는 연결: 요청(plist)을 보내고 프레임을 읽는다 */
function open(opts: UsbmuxOptions): Promise<{ sock: net.Socket; send(msg: Record<string, PlistValue>): void; next(): Promise<Record<string, PlistValue>>; rest(): Buffer }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(opts.socketPath ? { path: opts.socketPath } : defaultEndpoint());
    let buf = Buffer.alloc(0);
    const waiters: Array<{ ok: (v: Record<string, PlistValue>) => void; fail: (e: Error) => void }> = [];
    const frames: Array<Record<string, PlistValue>> = [];
    let tag = 1;
    let failure: Error | undefined;
    const pump = (): void => {
      while (buf.length >= 16 && buf.length >= buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        const msg = decodePlist(buf.subarray(16, len).toString('utf8')) as Record<string, PlistValue>;
        buf = buf.subarray(len);
        const w = waiters.shift();
        if (w) w.ok(msg); else frames.push(msg);
      }
    };
    const onData = (c: Buffer): void => { buf = Buffer.concat([buf, c]); pump(); };
    sock.on('data', onData);
    sock.on('error', (e) => { failure = e; for (const w of waiters.splice(0)) w.fail(e); reject(e); });
    sock.on('close', () => { const e = failure ?? new Error('usbmuxd 연결이 닫힘'); for (const w of waiters.splice(0)) w.fail(e); });
    sock.once('connect', () => resolve({
      sock,
      send(msg) {
        const body = Buffer.from(encodePlist({ ...msg, ClientVersionString: 'sinclair', ProgName: 'sinclair' }), 'utf8');
        const h = Buffer.alloc(16); h.writeUInt32LE(16 + body.length, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(8, 8); h.writeUInt32LE(tag++, 12);
        sock.write(Buffer.concat([h, body]));
      },
      next() {
        const f = frames.shift();
        if (f) return Promise.resolve(f);
        if (failure) return Promise.reject(failure);
        return new Promise((ok, fail) => {
          const t = setTimeout(() => fail(new Error('usbmuxd 응답 시간 초과')), opts.timeoutMs ?? 5_000);
          waiters.push({ ok: (v) => { clearTimeout(t); ok(v); }, fail: (e) => { clearTimeout(t); fail(e); } });
        });
      },
      /** Connect 성공 뒤: 프레임 처리를 멈추고 남은 바이트(이미 온 터널 데이터)를 돌려준다 */
      rest() { sock.off('data', onData); const r = buf; buf = Buffer.alloc(0); return r; },
    }));
  });
}

const htons = (p: number): number => ((p & 0xff) << 8) | ((p >> 8) & 0xff);
const toDevice = (v: Record<string, PlistValue>): UsbmuxDevice | undefined => {
  const p = (v.Properties ?? v) as Record<string, PlistValue>;
  const deviceId = (v.DeviceID ?? p.DeviceID) as number;
  if (typeof deviceId !== 'number' || typeof p.SerialNumber !== 'string') return undefined;
  return { deviceId, udid: p.SerialNumber, connection: p.ConnectionType === 'Network' ? 'Network' : 'USB' };
};

export function createUsbmuxClient(opts: UsbmuxOptions = {}): UsbmuxClient {
  return {
    async listDevices() {
      const c = await open(opts);
      try {
        c.send({ MessageType: 'ListDevices' });
        const r = await c.next();
        return ((r.DeviceList ?? []) as Array<Record<string, PlistValue>>).map(toDevice).filter((d): d is UsbmuxDevice => !!d);
      } finally { c.sock.destroy(); }
    },
    async connect(deviceId, port) {
      const c = await open(opts);
      c.send({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: htons(port) });
      const r = await c.next().catch((e: unknown) => { c.sock.destroy(); throw e; });
      if (r.Number !== 0) { c.sock.destroy(); throw new Error(`usbmux 연결 실패(기기 ${deviceId}, 포트 ${port}): ${RESULT_TEXT[r.Number as number] ?? `결과 ${String(r.Number)}`}`); }
      const rest = c.rest();
      if (rest.length) c.sock.unshift(rest);
      return c.sock;
    },
    async listen(onEvent) {
      const c = await open(opts);
      c.send({ MessageType: 'Listen' });
      const r = await c.next();
      if (r.Number !== 0) { c.sock.destroy(); throw new Error(`usbmux Listen 실패: 결과 ${String(r.Number)}`); }
      let alive = true;
      void (async () => {
        while (alive) {
          let m: Record<string, PlistValue>;
          try { m = await c.next(); } catch { return; }
          if (m.MessageType === 'Attached') { const d = toDevice(m); if (d) onEvent({ type: 'attached', ...d }); }
          else if (m.MessageType === 'Detached' && typeof m.DeviceID === 'number') onEvent({ type: 'detached', deviceId: m.DeviceID });
        }
      })();
      return () => { alive = false; c.sock.destroy(); };
    },
  };
}

/** lockdownd 의 페어링 없는 값(이름·모델·iOS 버전). 못 읽은 값은 비운다 */
export async function readLockdownValues(client: UsbmuxClient, deviceId: number): Promise<{ name?: string; productType?: string; productVersion?: string }> {
  const sock = await client.connect(deviceId, LOCKDOWN_PORT);
  let buf = Buffer.alloc(0);
  const waiters: Array<(v: Record<string, PlistValue>) => void> = [];
  sock.on('data', (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const len = buf.readUInt32BE(0);
      const msg = decodePlist(buf.subarray(4, 4 + len).toString('utf8')) as Record<string, PlistValue>;
      buf = buf.subarray(4 + len);
      waiters.shift()?.(msg);
    }
  });
  const get = (key: string): Promise<string | undefined> => new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), 3_000);
    waiters.push((m) => { clearTimeout(t); resolve(typeof m.Value === 'string' ? m.Value : undefined); });
    const body = Buffer.from(encodePlist({ Label: 'sinclair', Request: 'GetValue', Key: key }), 'utf8');
    const h = Buffer.alloc(4); h.writeUInt32BE(body.length);
    sock.write(Buffer.concat([h, body]));
  });
  try {
    const name = await get('DeviceName'), productType = await get('ProductType'), productVersion = await get('ProductVersion');
    return { ...(name ? { name } : {}), ...(productType ? { productType } : {}), ...(productVersion ? { productVersion } : {}) };
  } finally { sock.destroy(); }
}

/** 호스트 127.0.0.1 포트 → 기기 포트. 연결마다 새 usbmux 터널(러너 HTTP 처럼 짧은 연결이 많을 때) */
export async function forwardPort(client: UsbmuxClient, deviceId: number, devicePort: number, hostPort = 0): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((local) => {
    sockets.add(local);
    local.pause();
    void client.connect(deviceId, devicePort).then((remote) => {
      sockets.add(remote);
      local.pipe(remote); remote.pipe(local);
      local.resume();
      const end = (): void => { local.destroy(); remote.destroy(); sockets.delete(local); sockets.delete(remote); };
      local.on('close', end); remote.on('close', end); local.on('error', end); remote.on('error', end);
    }, () => { local.destroy(); sockets.delete(local); });
  });
  await new Promise<void>((r) => server.listen(hostPort, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
