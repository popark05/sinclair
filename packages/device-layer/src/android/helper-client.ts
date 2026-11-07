// 온디바이스 헬퍼(packages/device-layer/android-helper)와의 HTTP 세션. adb forward 터널 위에서 Bearer 토큰으로 말한다.
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { SemanticNode, SnapshotResult } from '@sinclair/protocol';
import type { Dadb } from '../adb/dadb.ts';
import type { AdbTunnel } from '../adb/services/forward.ts';

export const HELPER_PACKAGE = 'io.sinclair.helper';
export const HELPER_SERVICE = `${HELPER_PACKAGE}/${HELPER_PACKAGE}.SinclairAccessibilityService`;
/** 헬퍼 HelperServer.PORT 와 같아야 한다 */
export const HELPER_PORT = 38300;
const TOKEN_ACTION = `${HELPER_PACKAGE}.SET_TOKEN`;
const TOKEN_RECEIVER = `${HELPER_PACKAGE}/.TokenReceiver`;
/** 요청 하나의 상한. 루프백 + 포워드에서 /dump 도 수백 ms 안에 끝난다. */
const REQUEST_TIMEOUT_MS = 5_000;

export class HelperHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`헬퍼 HTTP ${status}: ${body}`);
  }
}

export interface HelperPing { ok: boolean; version: string; sdk: number }

/** 헬퍼 /snapshot 응답: SnapshotResult 에서 호스트가 붙이는 capturedAt 을 뺀 것. screenshot 이 없으면 원자 캡처 실패(detail 에 이유). */
export type HelperSnapshot = Omit<SnapshotResult, 'capturedAt' | 'screenshot'> & { screenshot?: SnapshotResult['screenshot'] };

export class HelperSession {
  /** 호스트 임의 포트 → 기기 HELPER_PORT 터널을 열고 세션 토큰을 만든다(아직 기기에 보내지는 않음). */
  static async open(dadb: Dadb): Promise<HelperSession> {
    const tunnel = await dadb.tcpForward(0, HELPER_PORT);
    return new HelperSession(dadb, tunnel, randomBytes(16).toString('hex'));
  }

  private constructor(
    private readonly dadb: Dadb,
    private readonly tunnel: AdbTunnel,
    readonly token: string
  ) {}

  /** WRITE_SECURE_SETTINGS 로 보호된 브로드캐스트로 토큰을 심는다(adb shell 만 가능). 토큰은 hex 라 따옴표 안에 안전하다. */
  async sendToken(): Promise<void> {
    await this.dadb.shell(`am broadcast -a ${TOKEN_ACTION} -n ${TOKEN_RECEIVER} --es token '${this.token}'`);
  }

  ping(): Promise<HelperPing> {
    return this.get('/ping') as Promise<HelperPing>;
  }

  dump(): Promise<SemanticNode> {
    return this.get('/dump') as Promise<SemanticNode>;
  }

  snapshot(): Promise<HelperSnapshot> {
    return this.get('/snapshot') as Promise<HelperSnapshot>;
  }

  close(): Promise<void> {
    return this.tunnel.close();
  }

  private get(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.tunnel.port, path, method: 'GET', headers: { authorization: `Bearer ${this.token}` }, timeout: REQUEST_TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) return reject(new HelperHttpError(res.statusCode ?? 0, body));
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`헬퍼 응답 JSON 파싱 실패: ${(e as Error).message}`)); }
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error(`헬퍼 응답 시간 초과(${path}, ${REQUEST_TIMEOUT_MS}ms)`)));
      req.on('error', reject);
      req.end();
    });
  }
}
