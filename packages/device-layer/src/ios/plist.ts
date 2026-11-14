// 최소 XML plist(ios-backend 01): usbmuxd·lockdownd 가 쓰는 부분만 — dict·array·string·integer·real·true/false·data. 외부 의존 없음.
export type PlistValue = string | number | boolean | Uint8Array | PlistValue[] | { [k: string]: PlistValue };

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function enc(v: PlistValue): string {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (v instanceof Uint8Array) return `<data>${Buffer.from(v).toString('base64')}</data>`;
  if (Array.isArray(v)) return `<array>${v.map(enc).join('')}</array>`;
  return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${enc(x)}`).join('')}</dict>`;
}

export function encodePlist(v: PlistValue): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${enc(v)}</plist>\n`;
}

/** 태그 열 토크나이저: 여는·닫는·빈 태그와 그 사이 글자 */
export function decodePlist(xml: string): PlistValue {
  // 선언(<?xml?>)·DOCTYPE·주석은 값이 아니다
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g)];
  let i = 0;
  // 사이의 공백 글자와 plist 껍데기 태그는 건너뛴다
  const skip = (): void => { while (i < tokens.length && (tokens[i]![4] !== undefined ? !tokens[i]![4]!.trim() : tokens[i]![2] === 'plist')) i++; };
  const text = (tag: string): string => {
    let s = '';
    i++;
    while (i < tokens.length && !(tokens[i]![1] === '/' && tokens[i]![2] === tag)) { s += tokens[i]![0]; i++; }
    i++; // 닫는 태그
    return unesc(s);
  };
  const value = (): PlistValue => {
    skip();
    const t = tokens[i];
    if (!t) throw new Error('plist: 값이 없음');
    const [, close, name, empty] = t;
    if (close) throw new Error(`plist: 예상하지 못한 닫는 태그 ${name}`);
    if (name === 'true' || name === 'false') { i++; if (!empty) i++; return name === 'true'; }
    if (name === 'string') return empty ? (i++, '') : text('string');
    if (name === 'integer') return Number(text('integer'));
    if (name === 'real') return Number(text('real'));
    if (name === 'data') return new Uint8Array(Buffer.from(text('data').replace(/\s+/g, ''), 'base64'));
    if (name === 'date') return text('date');
    if (name === 'array') {
      i++;
      if (empty) return [];
      const out: PlistValue[] = [];
      for (;;) { skip(); if (tokens[i]![1] === '/' && tokens[i]![2] === 'array') { i++; return out; } out.push(value()); }
    }
    if (name === 'dict') {
      i++;
      const out: Record<string, PlistValue> = {};
      if (empty) return out;
      for (;;) {
        skip();
        if (tokens[i]![1] === '/' && tokens[i]![2] === 'dict') { i++; return out; }
        if (tokens[i]![2] !== 'key') throw new Error(`plist: dict 안에 key 가 아닌 ${tokens[i]![2]}`);
        const k = text('key');
        out[k] = value();
      }
    }
    throw new Error(`plist: 모르는 태그 ${name}`);
  };
  return value();
}
