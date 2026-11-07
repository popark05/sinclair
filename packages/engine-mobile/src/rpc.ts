// 디바이스 레이어 JSON-RPC 호출 추상화. 테스트는 디스패처를 직접, 운영은 HTTP(토큰)를 쓴다.
import type { DeviceRpcMethod, DeviceRpcParams, JsonRpcResponse } from '@sinclair/protocol';
import type { RpcDispatcher } from '@sinclair/device-layer';

export interface DeviceRpc {
  call<M extends keyof DeviceRpcParams & DeviceRpcMethod>(method: M, params: DeviceRpcParams[M]): Promise<unknown>;
}

/** 디바이스 레이어가 돌려준 JSON-RPC 오류(code 는 RPC_ERRORS 값). */
export class DeviceRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'DeviceRpcError';
  }
}

function unwrap(response: JsonRpcResponse): unknown {
  if (response.error) throw new DeviceRpcError(response.error.code, response.error.message, response.error.data);
  return response.result;
}

let nextId = 1;

export function rpcOverDispatcher(dispatcher: RpcDispatcher): DeviceRpc {
  return {
    async call(method, params) {
      return unwrap(await dispatcher.handle({ jsonrpc: '2.0', id: nextId++, method, params: params as Record<string, unknown> }));
    },
  };
}

export function rpcOverHttp(options: { port: number; token: string; host?: string }): DeviceRpc {
  const url = `http://${options.host ?? '127.0.0.1'}:${options.port}/rpc`;
  return {
    async call(method, params) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      });
      if (!res.ok) throw new DeviceRpcError(-32603, `디바이스 레이어 HTTP ${res.status}`);
      return unwrap((await res.json()) as JsonRpcResponse);
    },
  };
}
