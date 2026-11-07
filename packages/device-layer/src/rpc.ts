// JSON-RPC 2.0 디스패처. 전송(HTTP/WebSocket)과 분리되어 있어 단위 테스트가 쉽다.
// 디바이스 호출은 기기별로 직렬화한다: 온디바이스 에이전트는 동시 요청을 안전하게 처리하지 못한다.
import { DEVICE_RPC_METHODS, type DeviceRpcMethod, type JsonRpcRequest, type JsonRpcResponse } from '@sinclair/protocol';

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  deviceNotFound: -32000,
  deviceBusy: -32001,
} as const;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

export class RpcDispatcher {
  private readonly handlers = new Map<DeviceRpcMethod, Handler>();
  private readonly locks = new Map<string, Promise<unknown>>();

  register(method: DeviceRpcMethod, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  registeredMethods(): DeviceRpcMethod[] {
    return [...this.handlers.keys()];
  }

  async handle(raw: unknown): Promise<JsonRpcResponse> {
    const req = raw as Partial<JsonRpcRequest>;
    const id = req?.id ?? null;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return error(id, RPC_ERRORS.invalidRequest, '잘못된 JSON-RPC 요청');
    }
    if (!(DEVICE_RPC_METHODS as readonly string[]).includes(req.method)) {
      return error(id, RPC_ERRORS.methodNotFound, `알 수 없는 메서드: ${req.method}`);
    }
    const handler = this.handlers.get(req.method as DeviceRpcMethod);
    if (!handler) return error(id, RPC_ERRORS.methodNotFound, `구현되지 않은 메서드: ${req.method}`);

    const params = req.params ?? {};
    const deviceId = typeof params['deviceId'] === 'string' ? params['deviceId'] : undefined;
    try {
      const result = deviceId
        ? await this.serialized(deviceId, () => handler(params))
        : await handler(params);
      return { jsonrpc: '2.0', id: id as number | string, result };
    } catch (e) {
      if (e instanceof RpcError) return error(id, e.code, e.message, e.data);
      return error(id, RPC_ERRORS.internal, e instanceof Error ? e.message : String(e));
    }
  }

  /** 같은 deviceId의 호출을 도착 순서대로 하나씩 실행한다 */
  private serialized<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(deviceId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(deviceId, next);
    // 호출자가 거부를 처리하므로 체인 정리용 파생 프로미스는 거부를 삼킨다
    void next.then(() => undefined, () => undefined).then(() => {
      if (this.locks.get(deviceId) === next) this.locks.delete(deviceId);
    });
    return next;
  }
}

function error(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: (id ?? 0) as number | string, error: data === undefined ? { code, message } : { code, message, data } };
}
