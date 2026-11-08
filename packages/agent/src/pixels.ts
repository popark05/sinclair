// 안전망의 픽셀 비교: 의존성 없는 최소 PNG 디코더(node:zlib) + 대상 영역의 평균 픽셀 차.
// 8비트 그레이·RGB·RGBA(·그레이+알파), 비인터레이스만. 그 밖(팔레트·16비트·인터레이스)·손상된 파일은 undefined — 비교를 건너뛴다(막지 않는다).
import { inflateSync } from 'node:zlib';

/** 영역 평균 차(0~1)가 이보다 크면 덮였다고 본다: 같은 화면의 압축·안티앨리어싱 흔들림(수 %)보다 크고, 팝업·다이얼로그가 덮을 때(대개 30% 이상)보다 작게 */
export const COVER_DIFF_THRESHOLD = 0.15;

export interface Bitmap { width: number; height: number; channels: number; data: Uint8Array }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buf: Uint8Array): Bitmap | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  let off = 8, width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  try {
    while (off + 8 <= b.length) {
      const len = b.readUInt32BE(off);
      const type = b.toString('latin1', off + 4, off + 8);
      const body = b.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = body.readUInt32BE(0); height = body.readUInt32BE(4);
        const depth = body[8], color = body[9]!, interlace = body[12];
        if (depth !== 8 || interlace !== 0 || !CHANNELS[color]) return undefined;
        channels = CHANNELS[color]!;
      } else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!width || !height || !channels || width * height > 40_000_000) return undefined;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return undefined;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]!;
      const src = y * (stride + 1) + 1, dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? out[dst + x - channels]! : 0;
        const up = y > 0 ? out[dst - stride + x]! : 0;
        const c = y > 0 && x >= channels ? out[dst - stride + x - channels]! : 0;
        const v = raw[src + x]!;
        let pred = 0;
        if (filter === 1) pred = a;
        else if (filter === 2) pred = up;
        else if (filter === 3) pred = (a + up) >> 1;
        else if (filter === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        else if (filter !== 0) return undefined;
        out[dst + x] = (v + pred) & 0xff;
      }
    }
    return { width, height, channels, data: out };
  } catch {
    return undefined;
  }
}

/** 두 스크린샷의 rect 영역 평균 채널 차(0~1). 해상도가 다르거나 읽을 수 없으면 undefined */
export function regionDiff(before: Uint8Array, after: Uint8Array, rect: { x: number; y: number; width: number; height: number }): number | undefined {
  const a = decodePng(before), b = decodePng(after);
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return undefined;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(a.width, Math.ceil(rect.x + rect.width)), y1 = Math.min(a.height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return undefined;
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let i = (y * a.width + x0) * a.channels; i < (y * a.width + x1) * a.channels; i++) { sum += Math.abs(a.data[i]! - b.data[i]!); n++; }
  return sum / (n * 255);
}
