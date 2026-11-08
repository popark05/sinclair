// 안전망 픽셀 비교: 테스트 안에서 만든 실제 PNG(필터 다섯 종)로 디코더를 확인하고, 대상 영역이 덮이면 실행하지 않는지 본다.
import { deflateSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { FakeEngine } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { decodePng, regionDiff, runAct, scriptedExecutor } from '../src/index.ts';

const W = 40, H = 40;
type Paint = (x: number, y: number) => [number, number, number];
const crc = (buf: Buffer): number => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (type: string, body: Buffer): Buffer => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
/** RGB 8비트 PNG. 행마다 filter 를 바꿔(0..4 순환) 디코더의 다섯 필터를 모두 지나게 한다 */
function png(paint: Paint): Uint8Array {
  const stride = W * 3;
  const px = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(paint(x, y), y * stride + x * 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < H; y++) {
    const f = y % 5;
    const row = Buffer.alloc(stride + 1); row[0] = f;
    for (let i = 0; i < stride; i++) {
      const v = px[y * stride + i]!, a = i >= 3 ? px[y * stride + i - 3]! : 0, b = y ? px[(y - 1) * stride + i]! : 0, c = y && i >= 3 ? px[(y - 1) * stride + i - 3]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[i + 1] = (v - pred) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}
const gradient: Paint = (x, y) => [x * 6, y * 6, (x + y) * 3];
const withBox = (x0: number, y0: number, x1: number, y1: number): Paint => (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? [250, 250, 250] : gradient(x, y));

describe('decodePng · regionDiff', () => {
  it('다섯 필터가 섞인 PNG 를 정확히 푼다', () => {
    const bmp = decodePng(png(gradient))!;
    expect(bmp).toMatchObject({ width: W, height: H, channels: 3 });
    for (const [x, y] of [[0, 0], [7, 3], [39, 39], [21, 17]] as const) expect([...bmp.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]).toEqual(gradient(x, y));
    expect(decodePng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeUndefined(); // 시그니처만(페이크 엔진)
  });

  it('영역 안의 변화만 센다', () => {
    const before = png(gradient), after = png(withBox(0, 0, 20, 10));
    expect(regionDiff(before, after, { x: 0, y: 0, width: 20, height: 10 })!).toBeGreaterThan(0.3);
    expect(regionDiff(before, after, { x: 0, y: 20, width: 40, height: 20 })).toBe(0);
  });
});

describe('안전망 · 픽셀', () => {
  const target: SemanticNode = { ref: '@r', role: 'root', rect: { x: 0, y: 0, width: W, height: H }, children: [{ ref: '@b', role: 'button', name: '결제', rect: { x: 0, y: 20, width: 40, height: 10 } }] };
  /** 관찰마다 shots 를 차례로 픽셀로 준다(트리는 그대로) */
  function engineShowing(shots: Uint8Array[]): FakeEngine {
    const engine = new FakeEngine({ root: target });
    let i = 0;
    engine.observe = async () => ({ root: structuredClone(target), pixels: shots[Math.min(i++, shots.length - 1)]!, atomic: true });
    return engine;
  }
  const exec = () => scriptedExecutor([{ name: 'tap', input: { ref: '@b' } }, { name: 'done', input: { summary: 'x' } }]);

  it('켜면: 트리는 같은데 대상 영역이 덮이면 실행하지 않고 다시 묻는다', async () => {
    const engine = engineShowing([png(gradient), png(withBox(0, 15, 40, 35))]);
    const r = await runAct(engine, '결제', { executor: exec(), safetyNet: { pixels: true } });
    expect(engine.performed).toEqual([]);
    expect(r.history[0]).toMatchObject({ result: 'rejected', guard: 'covered', detail: expect.stringMatching(/덮개/) });
  });

  it('켜도 다른 곳만 바뀌었으면 실행하고, 끄면(기본) 픽셀을 보지 않는다', async () => {
    const elsewhere = engineShowing([png(gradient), png(withBox(0, 0, 40, 10))]);
    await runAct(elsewhere, '결제', { executor: exec(), safetyNet: { pixels: true } });
    expect(elsewhere.performed).toEqual([{ ref: '@b', action: 'tap' }]);
    const off = engineShowing([png(gradient), png(withBox(0, 15, 40, 35))]);
    await runAct(off, '결제', { executor: exec() });
    expect(off.performed).toEqual([{ ref: '@b', action: 'tap' }]);
  });
});
