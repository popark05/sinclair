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
function png(paint: Paint, opts: { color?: 0 | 2 | 4 | 6; splitIdat?: boolean } = {}): Uint8Array {
  const color = opts.color ?? 2, ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  const stride = W * ch;
  const px = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([...paint(x, y), 255].slice(0, ch === 2 ? 1 : ch).concat(ch === 2 ? [255] : []), y * stride + x * ch);
  const rows: Buffer[] = [];
  for (let y = 0; y < H; y++) {
    const f = y % 5;
    const row = Buffer.alloc(stride + 1); row[0] = f;
    for (let i = 0; i < stride; i++) {
      const v = px[y * stride + i]!, a = i >= ch ? px[y * stride + i - ch]! : 0, b = y ? px[(y - 1) * stride + i]! : 0, c = y && i >= ch ? px[(y - 1) * stride + i - ch]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[i + 1] = (v - pred) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = color;
  const z = deflateSync(Buffer.concat(rows));
  const idat = opts.splitIdat ? [chunk('IDAT', z.subarray(0, 10)), chunk('IDAT', z.subarray(10))] : [chunk('IDAT', z)];
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...idat, chunk('IEND', Buffer.alloc(0))]));
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

describe('decodePng · 색 형식·청크', () => {
  it('RGBA·그레이+알파·그레이, 나뉜 IDAT 를 풀고, 잘린 파일은 undefined', () => {
    for (const [color, ch] of [[6, 4], [4, 2], [0, 1]] as const) {
      const bmp = decodePng(png(gradient, { color }))!;
      expect(bmp).toMatchObject({ width: W, height: H, channels: ch });
      expect(bmp.data[(5 * W + 7) * ch]).toBe(gradient(7, 5)[0]);
    }
    expect(decodePng(png(gradient, { splitIdat: true }))!.data[(5 * W + 7) * 3 + 1]).toBe(gradient(7, 5)[1]);
    const whole = png(gradient);
    expect(decodePng(whole.subarray(0, whole.length - 40))).toBeUndefined();
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
    const bad = engineShowing([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array([1, 2, 3])]);
    await runAct(bad, '결제', { executor: exec(), safetyNet: { pixels: true } });
    expect(bad.performed).toEqual([{ ref: '@b', action: 'tap' }]); // 못 읽는 픽셀은 막지 않는다
    const off = engineShowing([png(gradient), png(withBox(0, 15, 40, 35))]);
    await runAct(off, '결제', { executor: exec() });
    expect(off.performed).toEqual([{ ref: '@b', action: 'tap' }]);
  });
});

describe('안전망 · 픽셀 · 옮겨 간 대상', () => {
  it('대상이 아래로 밀려 옮겨 가면 옛 자리의 옛 그림과 새 자리의 새 그림을 비교한다(밀린 것을 덮개로 보지 않는다)', async () => {
    // 위쪽 10줄에 배너가 끼어들어 버튼(같은 그림)이 y 10 → 20 으로 내려간다
    const button: Paint = (x, y) => [x * 6, 100, 100 + (y % 10)];
    const before = png((x, y) => (y >= 10 && y < 20 ? button(x, y - 10) : [0, 0, 0]));
    const after = png((x, y) => (y < 10 ? [250, 250, 0] : y >= 20 && y < 30 ? button(x, y - 20) : [0, 0, 0]));
    const t0: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@b', role: 'button', name: '결제', rect: { x: 0, y: 10, width: 40, height: 10 } }] };
    const t1: SemanticNode = { ref: '@r', role: 'root', children: [{ ref: '@n', role: 'text', text: '배너', rect: { x: 0, y: 0, width: 40, height: 10 } }, { ref: '@b2', role: 'button', name: '결제', rect: { x: 0, y: 20, width: 40, height: 10 } }] };
    const engine = new FakeEngine({ root: t0 });
    const shots = [{ root: t0, pixels: before }, { root: t1, pixels: after }];
    let i = 0;
    engine.observe = async () => { const k = Math.min(i++, 1); if (k === 1) engine.setRoot(t1); return { root: structuredClone(shots[k]!.root), pixels: shots[k]!.pixels }; };
    await runAct(engine, '결제', { executor: scriptedExecutor([{ name: 'tap', input: { ref: '@b' } }, { name: 'done', input: { summary: 'x' } }]), safetyNet: { pixels: true } });
    expect(engine.performed).toEqual([{ ref: '@b2', action: 'tap' }]);
  });
});
