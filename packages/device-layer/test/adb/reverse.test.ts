// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import { Dadb } from '../../src/adb/dadb.ts';
import { AdbOperationFailedException } from '../../src/adb/results.ts';
import { AdbException } from '../../src/adb/errors.ts';
import { CMD_CLSE } from '../../src/adb/protocol/constants.ts';
import { FakeAndroid } from './fake-android.ts';
import { memoryDevice, tcpDevice, type FakeDeviceStream } from './fake-device.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function memDadb(): { dadb: Dadb; phone: FakeAndroid } {
  const phone = new FakeAndroid();
  const { transport } = memoryDevice(phone.services);
  const dadb = new Dadb('mem', async () => transport, { keyPair: null });
  cleanups.push(() => dadb.close());
  return { dadb, phone };
}

/** 호스트 쪽 로컬 서버(프록시 역할). 접속하면 greeting을 보내고, 받은 데이터를 대문자로 돌려준다. */
async function localServer(greeting = ''): Promise<{ port: number; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    if (greeting) socket.write(greeting);
    socket.on('data', (d) => socket.write(d.toString().toUpperCase()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      })
  );
  return { port: (server.address() as net.AddressInfo).port, sockets };
}

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** 기기 스트림에서 n바이트를 받아 문자열로. */
async function recv(stream: FakeDeviceStream, n: number): Promise<string> {
  return ((await stream.readBytes(n)) ?? Buffer.alloc(0)).toString();
}

const wait = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Dadb.reverse', () => {
  it('기기 앱의 접속을 호스트 로컬 포트로 중계(양방향)', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer('hello from proxy\n');
    const rule = await dadb.reverse('tcp:8080', `tcp:${local.port}`);
    expect(rule).toMatchObject({ remote: 'tcp:8080', local: `tcp:${local.port}`, devicePort: 8080 });
    expect(phone.currentReverses().get('tcp:8080')).toBe(`tcp:${local.port}`);

    const app = (await phone.connectReverse(8080))!;
    expect(app).not.toBeNull();
    expect(await recv(app, 17)).toBe('hello from proxy\n');
    await app.send('get /');
    expect(await recv(app, 5)).toBe('GET /');
  });

  it('기기 앱의 동시 접속 여러 개', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer();
    await dadb.reverse('tcp:8080', `tcp:${local.port}`);
    const apps = await Promise.all([1, 2, 3].map(() => phone.connectReverse(8080)));
    await Promise.all(apps.map((a, i) => a!.send(`client${i}`)));
    expect(await Promise.all(apps.map((a) => recv(a!, 7)))).toEqual(['CLIENT0', 'CLIENT1', 'CLIENT2']);
    expect(local.sockets.length).toBe(3);
  });

  it('tcp:0이면 기기가 고른 포트를 돌려줌', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer();
    const rule = await dadb.reverse('tcp:0', `tcp:${local.port}`);
    expect(rule.devicePort).toBe(40000);
    expect(rule.remote).toBe('tcp:40000');
    expect(await phone.connectReverse(40000)).not.toBeNull();
  });

  it('로컬 포트에 아무도 없으면 기기 쪽 OPEN을 거부', async () => {
    const { dadb, phone } = memDadb();
    await dadb.reverse('tcp:8080', `tcp:${await closedPort()}`);
    expect(await phone.connectReverse(8080)).toBeNull();
  });

  it('등록하지 않은 목적지로 온 OPEN은 거부', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer();
    await dadb.reverse('tcp:8080', `tcp:${local.port}`);
    // 다른 클라이언트가 만든 규칙처럼 우리 목록에 없는 local 사양.
    phone.currentReverses().set('tcp:9090', 'tcp:22');
    expect(await phone.connectReverse(9090)).toBeNull();
  });

  it('로컬 소켓이 닫히면 기기 스트림도 닫힘, 기기가 닫으면 로컬 소켓도 닫힘', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer();
    await dadb.reverse('tcp:8080', `tcp:${local.port}`);

    const a = (await phone.connectReverse(8080))!;
    await wait();
    local.sockets[0]!.destroy();
    await wait();
    expect(a.hostClosed).toBe(true);

    const b = (await phone.connectReverse(8080))!;
    await wait();
    const closed = new Promise<void>((r) => local.sockets[1]!.on('close', () => r()));
    b.close();
    await closed;
  });

  /** 호스트가 이 기기 스트림으로 보낸 CLSE 수. */
  const closesSent = (phone: FakeAndroid, app: FakeDeviceStream): number =>
    app.device.received.filter((m) => m.command === CMD_CLSE && m.arg1 === app.deviceId).length;

  it('프록시가 FIN으로만 닫아도 기기에 CLSE를 정확히 한 번 보낸다', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer();
    await dadb.reverse('tcp:8080', `tcp:${local.port}`);
    const app = (await phone.connectReverse(8080))!;
    await wait();
    local.sockets[0]!.end();
    await wait(60);
    expect(app.hostClosed).toBe(true);
    expect(closesSent(phone, app)).toBe(1);
  });

  it('기기 OKAY를 기다리는 중에 프록시가 닫혀도 결국 CLSE한다(플러시 타임아웃)', async () => {
    const { dadb, phone } = memDadb();
    const local = await localServer('hi');
    await dadb.reverse('tcp:8080', `tcp:${local.port}`);
    const app = (await phone.connectReverse(8080))!;
    app.device.autoAck = false;
    await app.send('x');
    await wait();
    local.sockets[0]!.destroy();
    await wait(1300);
    expect(app.hostClosed).toBe(true);
  });

  it('동시 연결 48개가 응답 직후 로컬에서 닫혀도 데이터 유실 없이 모두 CLSE', async () => {
    const { dadb, phone } = memDadb();
    const body = Buffer.alloc(256 * 1024, 7);
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      socket.on('data', () => {
        socket.end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }));
    await dadb.reverse('tcp:8080', `tcp:${(server.address() as net.AddressInfo).port}`);

    const apps = (await Promise.all(Array.from({ length: 48 }, () => phone.connectReverse(8080)))).map((a) => a!);
    await Promise.all(apps.map((a) => a.send('go')));
    // 모든 연결이 CLSE될 때까지 기다린다.
    for (let i = 0; i < 100 && !apps.every((a) => a.hostClosed); i++) await wait(50);

    for (const app of apps) {
      expect(app.hostClosed).toBe(true);
      expect(app.received.reduce((n, b) => n + b.length, 0)).toBe(body.length);
      expect(closesSent(phone, app)).toBe(1);
    }
  });

  it('프록시가 마지막 조각을 쓰고 곧바로 닫아도(FIN/RST) 기기 ack 뒤에 순서대로 전달한 다음 CLSE한다', async () => {
    for (const reset of [false, true]) {
      const { dadb, phone } = memDadb();
      const sockets: net.Socket[] = [];
      const server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on('error', () => {});
        setTimeout(() => socket.write(Buffer.alloc(1870, 1)), 20);
        setTimeout(() => socket.write(Buffer.alloc(27, 2)), 50);
        setTimeout(() => (reset ? socket.resetAndDestroy() : socket.end()), 55);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      cleanups.push(() => new Promise<void>((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }));
      await dadb.reverse('tcp:8080', `tcp:${(server.address() as net.AddressInfo).port}`);

      const app = (await phone.connectReverse(8080))!;
      app.device.autoAck = false;
      await wait(150); // 프록시가 두 조각을 쓰고 닫을 때까지. 기기는 아직 아무것도 ack하지 않았다.
      // TCP 가 두 쓰기를 한 세그먼트로 합칠 수 있다(부하가 걸린 전체 스위트에서 실제로 그렇다). 지키려는 성질은
      // "ack 전에는 WRTE 하나만, 모든 바이트가 순서대로 도착한 뒤에야 CLSE" 이지 조각 경계가 아니다.
      const total = () => app.received.reduce((n, b) => n + b.length, 0);
      expect(app.received).toHaveLength(1);
      expect([1870, 1897]).toContain(total());
      expect(app.hostClosed).toBe(false);

      // WRTE 를 하나씩 ack 하며 전부 도착할 때까지. 마지막 바이트가 오기 전에는 닫히면 안 된다.
      for (let guard = 0; total() < 1897 && guard < 5; guard++) {
        app.ackOne();
        await wait(60);
        expect(app.hostClosed).toBe(false);
      }
      const all = Buffer.concat(app.received);
      expect(all.length).toBe(1897);
      expect(all.subarray(0, 1870).every((x) => x === 1) && all.subarray(1870).every((x) => x === 2)).toBe(true); // 순서 보존

      app.ackOne(); // 마지막 ack → 이제 CLSE.
      await wait(60);
      expect(app.hostClosed).toBe(true);
      expect(closesSent(phone, app)).toBe(1);
    }
  });

  it('adbd가 거부하면 AdbOperationFailedException(AdbException 아님)', async () => {
    const { dadb, phone } = memDadb();
    phone.busyRemote = 'tcp:8080';
    const thrown = await dadb.reverse('tcp:8080', 'tcp:1234').catch((e) => e);
    expect(thrown).toBeInstanceOf(AdbOperationFailedException);
    expect(thrown).not.toBeInstanceOf(AdbException);
    expect(thrown.reason).toContain('Address already in use');
  });

  it('norebind: 이미 있는 규칙은 덮어쓰지 않음', async () => {
    const { dadb } = memDadb();
    await dadb.reverse('tcp:8080', 'tcp:1234');
    await expect(dadb.reverse('tcp:8080', 'tcp:5678', { noRebind: true })).rejects.toBeInstanceOf(
      AdbOperationFailedException
    );
  });

  it('호스트 쪽이 tcp:<port>가 아니면 RangeError', async () => {
    const { dadb } = memDadb();
    await expect(dadb.reverse('tcp:8080', 'localabstract:foo')).rejects.toBeInstanceOf(RangeError);
  });

  it('list / close(멱등) / killAll', async () => {
    const { dadb, phone } = memDadb();
    const a = await dadb.reverse('tcp:8080', 'tcp:1111');
    await dadb.reverse('tcp:8081', 'tcp:2222');
    expect(await dadb.listReverse()).toEqual([
      { remote: 'tcp:8080', local: 'tcp:1111' },
      { remote: 'tcp:8081', local: 'tcp:2222' }
    ]);

    await a.close();
    await a.close();
    expect([...phone.currentReverses().keys()]).toEqual(['tcp:8081']);
    await expect(dadb.killReverse('tcp:8080')).rejects.toBeInstanceOf(AdbOperationFailedException);

    await dadb.killAllReverse();
    expect(await dadb.listReverse()).toEqual([]);
  });

  it('연결이 끊기면(adbd가 규칙 삭제) 재연결 시 규칙을 다시 설치', async () => {
    const phone = new FakeAndroid();
    const server = await tcpDevice(phone.services);
    cleanups.push(() => server.close());
    const dadb = Dadb.create('127.0.0.1', server.port, { keyPair: null });
    cleanups.push(() => dadb.close());
    const local = await localServer();

    await dadb.reverse('tcp:8080', `tcp:${local.port}`);
    server.sockets[0]!.destroy();
    await wait();

    // 다음 작업이 재연결을 일으키고, 새 연결에 규칙이 다시 설치된다.
    await dadb.shell('echo hi');
    expect(server.devices.length).toBe(2);
    expect(phone.reverses.get(server.devices[1]!)?.get('tcp:8080')).toBe(`tcp:${local.port}`);

    const app = (await phone.connectReverse(8080))!;
    await app.send('ping');
    expect(await recv(app, 4)).toBe('PING');
  });

  it('close한 규칙은 재연결 때 다시 설치하지 않음', async () => {
    const phone = new FakeAndroid();
    const server = await tcpDevice(phone.services);
    cleanups.push(() => server.close());
    const dadb = Dadb.create('127.0.0.1', server.port, { keyPair: null });
    cleanups.push(() => dadb.close());

    const rule = await dadb.reverse('tcp:8080', 'tcp:1111');
    await rule.close();
    server.sockets[0]!.destroy();
    await wait();
    await dadb.shell('echo hi');
    expect(phone.reverses.get(server.devices[1]!)?.size ?? 0).toBe(0);
  });
});
