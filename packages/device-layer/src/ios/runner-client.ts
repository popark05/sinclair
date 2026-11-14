// iOS 러너 HTTP 클라이언트(ios-backend 02): 기기 안 XCUITest 러너(호스트 포트 포워드 너머)에 Bearer 토큰으로.
// 계약(Android 헬퍼와 같은 모양): GET /ping·/dump·/snapshot·/app/foreground, POST /action·/app. 러너는 포인트, 호스트는 픽셀 — 여기서 배율로 바꾼다.
import * as http from 'node:http';
import type { Point, SemanticNode, SnapshotResult } from '@sinclair/protocol';
import { toSemanticTree, type IosElement } from './ios-tree.ts';

export interface IosRunnerPing { ok: boolean; version: string; iosVersion: string; model: string; screen: { width: number; height: number }; scale: number }
export const IOS_RUNNER_PORT = 22087;
const TIMEOUT_MS: Record<string, number> = { '/snapshot': 15_000 };
const round2 = (v: number): number => Math.round(v * 100) / 100;

export class IosRunnerClient {
  private scale = 0;
  constructor(private readonly port: number, private readonly token: string) {}

  async ping(): Promise<IosRunnerPing> {
    const p = await this.request('GET', '/ping') as IosRunnerPing;
    if (typeof p.scale === 'number' && p.scale > 0) this.scale = p.scale;
    return p;
  }
  private async ensureScale(): Promise<number> { if (!this.scale) await this.ping(); return this.scale || 1; }
  private pt(p: Point, scale: number): { x: number; y: number } { return { x: round2(p.x / scale), y: round2(p.y / scale) }; }

  async dump(bundleId?: string): Promise<SemanticNode> {
    const scale = await this.ensureScale();
    const r = await this.request('GET', `/dump${bundleId ? `?bundleId=${encodeURIComponent(bundleId)}` : ''}`) as { root: IosElement };
    return toSemanticTree(r.root, scale);
  }
  async snapshot(): Promise<Omit<SnapshotResult, 'capturedAt'>> {
    const scale = await this.ensureScale();
    const r = await this.request('GET', '/snapshot') as { root: IosElement; screenshot?: string };
    return { root: toSemanticTree(r.root, scale), ...(r.screenshot ? { screenshot: { format: 'png' as const, base64: r.screenshot }, atomic: true } : { screenshot: { format: 'png' as const, base64: '' }, atomic: false, detail: '러너가 스크린샷 없이 응답함' }) };
  }
  async tap(p: Point): Promise<void> { const s = await this.ensureScale(); await this.request('POST', '/action', { action: 'tap', ...this.pt(p, s) }); }
  async longPress(p: Point, durationMs: number): Promise<void> { const s = await this.ensureScale(); await this.request('POST', '/action', { action: 'long_press', ...this.pt(p, s), durationMs }); }
  async swipe(a: Point, b: Point, durationMs: number): Promise<void> {
    const s = await this.ensureScale();
    const from = this.pt(a, s), to = this.pt(b, s);
    await this.request('POST', '/action', { action: 'swipe', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs });
  }
  async type(text: string): Promise<void> { await this.request('POST', '/action', { action: 'type', text }); }
  /** 키: return·delete·tab·escape 등(러너가 XCUIKeyboardKey 로) */
  async key(key: string): Promise<void> { await this.request('POST', '/action', { action: 'key', key }); }
  /** 하드웨어 버튼: home·volume_up·volume_down(XCUIDevice.Button) */
  async button(name: 'home' | 'volume_up' | 'volume_down'): Promise<void> { await this.request('POST', '/action', { action: 'button', button: name }); }
  async app(action: 'launch' | 'terminate' | 'activate', bundleId: string): Promise<void> { await this.request('POST', '/app', { action, bundleId }); }
  async foreground(): Promise<string | null> { return ((await this.request('GET', '/app/foreground')) as { bundleId: string | null }).bundleId; }

  private request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const timeout = TIMEOUT_MS[path] ?? 5_000;
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, path, method, timeout, headers: { authorization: `Bearer ${this.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`iOS 러너 ${path}: HTTP ${res.statusCode} ${text.slice(0, 200)}`));
          try { resolve(text ? JSON.parse(text) : null); } catch (e) { reject(new Error(`iOS 러너 응답 JSON 파싱 실패(${path}): ${(e as Error).message}`)); }
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`iOS 러너 응답 시간 초과(${path}, ${timeout}ms)`)));
      req.on('error', reject);
      req.end(payload);
    });
  }
}
