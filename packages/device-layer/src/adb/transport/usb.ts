/**
 * USB 전송: adb server 없이 기기의 ADB 인터페이스(bulk IN/OUT)를 직접 사용한다. dadb에는 없는 확장
 * (dadb는 USB 기기를 adb server의 host:transport로만 다룬다).
 *
 * `usb` 패키지(node-usb 3.x, WebUSB API, N-API라 Electron 재빌드 불필요)를 쓰되, 테스트를 위해
 * 우리가 쓰는 WebUSB 표면(UsbDeviceLike)에만 의존한다.
 *
 * 읽기 규칙(AOSP client/usb_libusb.cpp와 동일): 헤더 24바이트를 먼저, 그다음 payload를 정확한 길이로 읽는다.
 * - node-usb의 transferIn은 버퍼를 패킷 크기 배수로 잡고 결과를 요청 길이로 "잘라낸다". 요청보다 많이 오면
 *   초과분이 사라지므로, adbd가 헤더/본문을 별도 전송으로 보낸다는 전제로 정확한 길이만 요청한다.
 * - 큰 버퍼로 뭉뚱그려 읽으면 payload가 패킷 크기 배수일 때(ZLP 없음) 전송이 끝나지 않아
 *   기기는 OKAY를, 우리는 전송 완료를 기다리는 교착이 생긴다.
 * - transferIn의 timeout은 만료 시 전송을 취소한다(0은 즉시 만료). 유휴 대기는 헤더 읽기를 짧은 주기로
 *   다시 시도한다. 헤더는 단일 패킷이라 취소돼도 일부만 받는 일이 없다. payload 도중의 시간 초과는 치명적이다.
 *
 * 쓰기 규칙: 전송 하나 = write 한 번. 길이가 패킷 크기의 배수면 ZLP(길이 0 전송)를 덧붙여 끝을 알린다
 * (AOSP의 LIBUSB_TRANSFER_ADD_ZERO_PACKET).
 */

import type { AdbTransport } from './transport.ts';
import {
  AdbConnectException,
  AdbConnectionClosedException,
  AdbTimeoutException,
  AdbUsbAccessException
} from '../errors.ts';
import { HEADER_LENGTH } from '../protocol/constants.ts';
import { ADB_TRACE, adbTrace } from '../trace.ts';

/** ADB 인터페이스 식별자(AOSP adb: ADB_CLASS/ADB_SUBCLASS/ADB_PROTOCOL). */
export const ADB_CLASS = 0xff;
export const ADB_SUBCLASS = 0x42;
export const ADB_PROTOCOL = 0x01;

// ---- 우리가 쓰는 WebUSB 표면(node-usb UsbDevice가 구조적으로 만족) ----

export interface UsbEndpointLike {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: string;
  packetSize: number;
}

export interface UsbAlternateLike {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: UsbEndpointLike[];
}

export interface UsbInterfaceLike {
  interfaceNumber: number;
  alternates: UsbAlternateLike[];
}

export interface UsbConfigurationLike {
  configurationValue: number;
  interfaces: UsbInterfaceLike[];
}

export interface UsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string | null;
  readonly productName?: string | null;
  readonly manufacturerName?: string | null;
  readonly opened: boolean;
  /** 현재 선택된 구성. node-usb는 열려 있지 않으면 내부적으로 열어서 읽는다(실패/미선택 시 throw). */
  readonly configuration?: UsbConfigurationLike | null;
  /** 기기가 가진 모든 구성(선택 여부와 무관). */
  readonly configurations?: UsbConfigurationLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  /** Windows에서는 no-op(WebUSB 규약). */
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  /** node-usb 확장: 세 번째 인자가 timeout(ms). 만료 시 "…error: Cancelled"로 reject. */
  transferIn(endpointNumber: number, length: number, timeout?: number): Promise<{ data?: DataView; status: string }>;
  transferOut(
    endpointNumber: number,
    data: Uint8Array,
    timeout?: number
  ): Promise<{ bytesWritten: number; status: string }>;
}

export interface AdbUsbInterface {
  /**
   * ADB 인터페이스가 있는 구성. 아직 선택되지 않은 구성이면 selectConfiguration이 필요하다.
   * macOS(nusb)는 기기 클래스가 0x00(composite)이거나 알려진 드라이버가 있을 때만 구성을 자동 선택한다.
   * USB 테더링 등으로 0xEF(IAD)를 보고하는 Android 기기는 구성이 선택되지 않은 상태일 수 있다.
   */
  configurationValue: number;
  needsConfiguration: boolean;
  interfaceNumber: number;
  alternateSetting: number;
  inEndpoint: number;
  outEndpoint: number;
  /** bulk 최대 패킷 크기(USB 2.0 High-Speed 512, SuperSpeed 1024). ZLP 판단에 쓴다. */
  packetSize: number;
}

/**
 * 기기에서 ADB 인터페이스(0xff/0x42/0x01 + bulk IN/OUT)를 찾는다. 없거나 읽을 수 없으면 undefined.
 * 현재 구성을 먼저 보고, 선택된 구성이 없거나 읽을 수 없으면 전체 구성 목록에서 찾는다.
 */
export function findAdbInterface(device: UsbDeviceLike): AdbUsbInterface | undefined {
  let active: UsbConfigurationLike | undefined;
  try {
    active = device.configuration ?? undefined;
  } catch {
    active = undefined;
  }
  if (active) {
    const found = findInConfiguration(active);
    if (found) return { ...found, needsConfiguration: false };
  }
  let all: UsbConfigurationLike[] = [];
  try {
    all = device.configurations ?? [];
  } catch {
    all = [];
  }
  for (const configuration of all) {
    if (active && configuration.configurationValue === active.configurationValue) continue;
    const found = findInConfiguration(configuration);
    if (found) return { ...found, needsConfiguration: true };
  }
  return undefined;
}

function findInConfiguration(configuration: UsbConfigurationLike): Omit<AdbUsbInterface, 'needsConfiguration'> | undefined {
  for (const iface of configuration.interfaces ?? []) {
    for (const alt of iface.alternates) {
      if (
        alt.interfaceClass !== ADB_CLASS ||
        alt.interfaceSubclass !== ADB_SUBCLASS ||
        alt.interfaceProtocol !== ADB_PROTOCOL
      ) {
        continue;
      }
      const bulkIn = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
      const bulkOut = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
      if (!bulkIn || !bulkOut) continue;
      return {
        configurationValue: configuration.configurationValue,
        interfaceNumber: iface.interfaceNumber,
        alternateSetting: alt.alternateSetting,
        inEndpoint: bulkIn.endpointNumber,
        outEndpoint: bulkOut.endpointNumber,
        packetSize: bulkOut.packetSize || 512
      };
    }
  }
  return undefined;
}

export interface UsbTransportOptions {
  /** 전송 하나가 끝나기까지의 기한(ms). 기본 10초(TcpTransport와 같은 의도). */
  writeTimeoutMs?: number;
  /** 유휴 시 헤더 읽기 재시도 주기(ms). close가 읽기 루프를 멈추는 데 걸리는 최대 시간이기도 하다. 기본 1초. */
  idlePollMs?: number;
  /** 헤더를 받은 뒤 payload를 모두 받기까지의 기한(ms). 기본 30초. */
  payloadTimeoutMs?: number;
  /**
   * 열기/점유 실패 시 재시도 횟수. 기본: Windows 2, 그 외 0.
   * nusb 문서: Windows에서는 연결 직후 composite 기기의 인터페이스가 아직 준비되지 않았을 수 있다.
   */
  claimRetries?: number;
}

const DEFAULT_WRITE_TIMEOUT = 10_000;
/**
 * open 직후 잔여 입력 버리기: 이 시간 동안 아무것도 안 오면 끝난 것으로 본다(연결마다 한 번 치르는 비용).
 * 이전 세션이 큰 응답(수 MB 스크린샷)을 받다 끊기면 adbd 가 그 스트림의 미확인 WRTE 를 한동안 계속 보내므로 고정 시간이 아니라 "조용해질 때까지" 기다린다.
 */
const STALE_INPUT_QUIET_MS = 150;
/** 잔여 입력 버리기의 상한. 스트림당 미확인 WRTE 는 1개(≤1MB)라 실제로는 수백 ms 안에 조용해진다. */
const STALE_INPUT_MAX_MS = 3_000;
const DEFAULT_IDLE_POLL = 1_000;
const DEFAULT_PAYLOAD_TIMEOUT = 30_000;
const CLAIM_RETRY_DELAY = 300;

export class UsbTransport implements AdbTransport {
  private readonly dataListeners: Array<(chunk: Uint8Array) => void> = [];
  /** open 직후 잔여 데이터를 버리는 동안 true. */
  private discarding = true;
  /** 읽기 루프가 헤더의 첫 바이트를 기다리는 중(= 패킷 경계)이면 true. */
  private atPacketBoundary = true;
  /** 헤더 패킷에 섞여 온 본문 앞부분. 다음 readExact 가 먼저 소비한다. */
  private pending: Buffer | undefined;
  /** 잔여 입력 버리기 통계. */
  private lastDiscardedAt = 0;
  private discardedBytes = 0;
  private readonly closeListeners: Array<(error?: Error) => void> = [];
  private closed = false;
  private closeError: Error | undefined;
  private readLoop: Promise<void> = Promise.resolve();
  private releasing: Promise<void> | undefined;

  private constructor(
    private readonly device: UsbDeviceLike,
    readonly adbInterface: AdbUsbInterface,
    private readonly options: Required<UsbTransportOptions>
  ) {}

  /**
   * 기기를 열고 ADB 인터페이스를 점유한다.
   * adb server 등 다른 프로그램이 인터페이스를 잡고 있으면 AdbConnectException(원인 안내 포함).
   */
  static async open(device: UsbDeviceLike, options: UsbTransportOptions = {}): Promise<UsbTransport> {
    const adbInterface = findAdbInterface(device);
    if (!adbInterface) {
      throw new AdbConnectException(
        `ADB 인터페이스를 찾을 수 없습니다(${describeDevice(device)}). 기기에서 USB 디버깅이 켜져 있는지 확인하세요.`
      );
    }
    const retries = options.claimRetries ?? (process.platform === 'win32' ? 2 : 0);
    for (let attempt = 0; ; attempt++) {
      try {
        if (!device.opened) await device.open();
        if (adbInterface.needsConfiguration) await device.selectConfiguration(adbInterface.configurationValue);
        await device.claimInterface(adbInterface.interfaceNumber);
        if (adbInterface.alternateSetting !== 0) {
          await device.selectAlternateInterface(adbInterface.interfaceNumber, adbInterface.alternateSetting);
        }
        break;
      } catch (e) {
        await device.close().catch(() => undefined);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, CLAIM_RETRY_DELAY));
          continue;
        }
        throw new AdbUsbAccessException(
          `USB 기기의 ADB 인터페이스를 열지 못했습니다(${describeDevice(device)}). ${accessHint()}`,
          e
        );
      }
    }
    // 이전 세션이 남긴 halt 상태를 지운다(AOSP도 연결 시 clear_halt). 실패는 무시.
    await device.clearHalt('in', adbInterface.inEndpoint).catch(() => undefined);
    await device.clearHalt('out', adbInterface.outEndpoint).catch(() => undefined);

    const transport = new UsbTransport(device, adbInterface, {
      writeTimeoutMs: options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT,
      idlePollMs: options.idlePollMs ?? DEFAULT_IDLE_POLL,
      payloadTimeoutMs: options.payloadTimeoutMs ?? DEFAULT_PAYLOAD_TIMEOUT,
      claimRetries: retries
    });
    transport.readLoop = transport.runReadLoop();
    await transport.discardStaleInput();
    return transport;
  }

  /**
   * 이전 프로세스가 스트림을 열어 둔 채 끝나면 adbd 가 보낸 CLSE/WRTE 가 IN 엔드포인트에 남아 있다가 새 세션의
   * CNXN 응답 앞에 끼어들어 핸드셰이크를 깨뜨린다(실기기에서 "예상치 못한 응답 CLSE", 헤더 magic 오류로 관찰).
   * 호스트가 CNXN 을 보내기 전에는 adbd 가 먼저 말하지 않으므로, 잠시 동안 읽히는 것은 모두 버린다.
   * 별도 transferIn 으로 비우면 안 된다: 타임아웃으로 취소된 전송이 뒤이어 오는 응답을 삼켜 핸드셰이크가 멈춘다(실기기 확인).
   * 그래서 평소 읽기 루프를 그대로 돌리되 리스너에 전달하지 않고, 패킷 경계에서 넘긴다.
   */
  private async discardStaleInput(): Promise<void> {
    const started = Date.now();
    this.lastDiscardedAt = started;
    for (;;) {
      if (this.closed) break;
      const quietFor = Date.now() - this.lastDiscardedAt;
      if (this.atPacketBoundary && quietFor >= STALE_INPUT_QUIET_MS) break;
      if (Date.now() - started >= STALE_INPUT_MAX_MS && this.atPacketBoundary) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (ADB_TRACE && this.discardedBytes > 0) adbTrace(`usb open: 이전 세션 잔여 ${this.discardedBytes} bytes 버림 (${Date.now() - started}ms)`);
    this.discarding = false;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw this.closeError ?? new AdbConnectionClosedException('USB 연결이 닫혔습니다.');
    const { outEndpoint, packetSize } = this.adbInterface;
    try {
      await this.transferOut(outEndpoint, data);
      if (data.length > 0 && data.length % packetSize === 0) {
        await this.transferOut(outEndpoint, new Uint8Array(0));
      }
    } catch (e) {
      const error = isCancelled(e)
        ? new AdbTimeoutException(`USB 쓰기 시간 초과(${this.options.writeTimeoutMs}ms): 기기가 응답하지 않습니다.`, e)
        : new AdbConnectionClosedException('USB 쓰기 실패: 기기 연결이 끊겼습니다.', e);
      // 멈추거나 끊긴 USB 연결은 되살릴 수 없으므로 닫는다 → 다음 작업에서 재연결.
      void this.shutdown(error);
      throw error;
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (error?: Error) => void): void {
    if (this.closed) {
      queueMicrotask(() => listener(this.closeError));
      return;
    }
    this.closeListeners.push(listener);
  }

  close(): Promise<void> {
    return this.shutdown();
  }

  // ---- 내부 ----

  private async transferOut(endpoint: number, data: Uint8Array): Promise<void> {
    const result = await this.device.transferOut(endpoint, data, this.options.writeTimeoutMs);
    if (result.status !== 'ok') throw new Error(`transferOut status: ${result.status}`);
  }

  /** 헤더 → payload 순으로 정확한 길이만 읽어 청크로 내보낸다. */
  private async runReadLoop(): Promise<void> {
    try {
      while (!this.closed) {
        this.atPacketBoundary = true;
        const header = await this.readExact(HEADER_LENGTH, true);
        if (!header) return; // 유휴 대기 중 close
        this.atPacketBoundary = false;
        this.emit(header);
        const payloadLength = header.readUInt32LE(12);
        if (payloadLength > 0) {
          const payload = await this.readExact(payloadLength, false);
          if (!payload) return;
          this.emit(payload);
        }
      }
    } catch (e) {
      if (this.closed) return;
      const error = isCancelled(e)
        ? new AdbTimeoutException('USB 읽기 시간 초과: payload를 끝까지 받지 못했습니다.', e)
        : new AdbConnectionClosedException('USB 읽기 실패: 기기 연결이 끊겼습니다.', e);
      void this.shutdown(error);
    }
  }

  /**
   * 정확히 n바이트를 읽는다. idle이면 첫 바이트를 기다리는 동안 짧은 주기로 재시도하고,
   * 그 사이 close되면 null.
   */
  private async readExact(n: number, idle: boolean): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let have = 0;
    // 지난 읽기에서 남은 바이트(헤더 패킷에 본문 앞부분이 섞여 온 경우)를 먼저 쓴다.
    if (this.pending) {
      const take = this.pending.subarray(0, n);
      this.pending = this.pending.length > n ? this.pending.subarray(n) : undefined;
      parts.push(take);
      have = take.length;
    }
    while (have < n) {
      if (this.closed) return null;
      const waitingForFirstByte = idle && have === 0;
      // 헤더(24바이트)는 패킷 하나를 통째로 요청한다: 일부 adbd 는 헤더와 본문을 한 전송으로 보내 한 패킷에 섞이는데,
      // node-usb 가 요청 길이로 잘라내면 초과분이 사라져 스트림이 어긋난다(실기기 Samsung 에서 관찰). 헤더만 오면 짧은
      // 패킷이라 전송이 바로 끝나고, 섞여 오면 가득 찬 패킷이 바로 돌아오므로 교착은 없다. 본문은 정확한 길이만 요청한다
      // (패킷 크기 배수인 본문에서 ZLP 없이 전송이 끝나지 않는 교착을 피하기 위해).
      const request = idle && have === 0 ? Math.max(n, this.adbInterface.packetSize) : n - have;
      let result: { data?: DataView; status: string };
      try {
        result = await this.device.transferIn(
          this.adbInterface.inEndpoint,
          request,
          waitingForFirstByte ? this.options.idlePollMs : this.options.payloadTimeoutMs
        );
      } catch (e) {
        if (waitingForFirstByte && isCancelled(e)) continue; // 유휴: 다시 기다린다.
        throw e;
      }
      if (result.status !== 'ok') throw new Error(`transferIn status: ${result.status}`);
      const view = result.data;
      if (!view || view.byteLength === 0) continue; // ZLP
      const chunk = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      const need = n - have;
      if (chunk.length > need) {
        this.pending = chunk.subarray(need);
        parts.push(chunk.subarray(0, need));
        have = n;
      } else {
        parts.push(chunk);
        have += chunk.length;
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  private emit(chunk: Buffer): void {
    if (this.discarding) {
      this.lastDiscardedAt = Date.now();
      this.discardedBytes += chunk.length;
      return;
    }
    for (const listener of this.dataListeners) listener(chunk);
  }

  /** 닫기(멱등): 읽기 루프가 멈추길 잠깐 기다린 뒤 인터페이스를 놓고 기기를 닫는다. */
  private shutdown(error?: Error): Promise<void> {
    if (this.releasing) return this.releasing;
    if (ADB_TRACE && error) adbTrace(`usb shutdown: ${error.message}${error.cause instanceof Error ? ` <- ${error.cause.message}` : ''}`);
    this.closed = true;
    this.closeError = error;
    this.releasing = (async () => {
      // 유휴 읽기는 idlePollMs 안에 끝난다. payload 읽기 중이면 오래 걸릴 수 있어 상한을 둔다.
      await Promise.race([
        this.readLoop,
        new Promise((r) => setTimeout(r, this.options.idlePollMs + 1_000))
      ]);
      await this.device.releaseInterface(this.adbInterface.interfaceNumber).catch(() => undefined);
      await this.device.close().catch(() => undefined);
      for (const listener of this.closeListeners.splice(0)) listener(error);
    })();
    return this.releasing;
  }
}

/** 점유 실패 시 사용자 안내(플랫폼별). */
export function accessHint(platform: NodeJS.Platform = process.platform): string {
  const common =
    '다른 프로그램(adb server, Android Studio 등)이 기기를 사용 중일 수 있습니다. 해당 프로그램을 끄거나 `adb kill-server`로 종료하세요.';
  if (platform === 'win32') {
    return (
      `${common} Windows에서는 기기의 ADB 인터페이스에 WinUSB 드라이버가 필요합니다. 최신 Android는 자동으로 ` +
      'WinUSB가 설치되지만, 제조사 드라이버가 다른 드라이버로 바꿨다면 장치 관리자에서 ' +
      '"Android ADB Interface"를 Google USB Driver(WinUSB)로 변경하세요.'
    );
  }
  return common;
}

/** node-usb는 timeout 만료를 전송 취소(Cancelled)로 보고한다. */
function isCancelled(error: unknown): boolean {
  return error instanceof Error && /Cancelled/i.test(error.message);
}

export function describeDevice(device: UsbDeviceLike): string {
  const id = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
  const name = safe(() => device.productName) ?? '';
  const serial = safe(() => device.serialNumber) ?? '';
  return [name, id, serial && `serial=${serial}`].filter(Boolean).join(' ');
}

function hex4(value: number): string {
  return value.toString(16).padStart(4, '0');
}

/** node-usb의 문자열 getter는 기기를 열다가 throw할 수 있다. */
export function safe<T>(read: () => T | null | undefined): T | undefined {
  try {
    return read() ?? undefined;
  } catch {
    return undefined;
  }
}
