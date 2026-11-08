// 비밀값 묶음: 모델은 자리표시 {{secret:이름}} 만 보고, 엔진에 입력하는 순간에만 실제 값으로 바꾼다.
// 값이 화면(secure 가 아닌 칸)·오류 문구로 되돌아오면 값 일치로 다시 자리표시로 가린다.
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{secret:([^}]*)\}\}/g;

export const secretPlaceholder = (name: string): string => `{{secret:${name}}}`;

export class SecretBox {
  private readonly values = new Map<string, string>();

  constructor(entries: Iterable<readonly [string, string]> = []) {
    for (const [name, value] of entries) this.add(name, value);
  }

  /** 이름은 대문자·숫자·_ (자리표시를 모델이 그대로 옮겨 쓰기 쉽고, 다른 문법과 섞이지 않게). 빈 값은 가릴 수 없어 받지 않는다 */
  add(name: string, value: string): void {
    if (!SECRET_NAME.test(name)) throw new Error(`비밀값 이름 ${JSON.stringify(name)}: 대문자로 시작하는 대문자·숫자·_ 64자 이내여야 함`);
    if (value === '') throw new Error(`비밀값 ${name} 이 비어 있음`);
    this.values.set(name, value);
  }

  get size(): number { return this.values.size; }
  has(name: string): boolean { return this.values.has(name); }

  mentions(text: string): boolean { PLACEHOLDER.lastIndex = 0; return PLACEHOLDER.test(text); }

  /** 자리표시를 실제 값으로. 등록되지 않은 이름이 하나라도 있으면 바꾸지 않고 사유를 돌려준다 */
  reveal(text: string): { ok: true; text: string } | { ok: false; error: string } {
    const unknown = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => !this.values.has(n));
    if (unknown.length) return { ok: false, error: `등록되지 않은 비밀값: ${[...new Set(unknown)].join(', ')} — 목표에 주어진 자리표시만 쓸 수 있음` };
    return { ok: true, text: text.replace(PLACEHOLDER, (_, n: string) => this.values.get(n)!) };
  }

  /** 실제 값을 자리표시로. 긴 값부터(한 값이 다른 값을 품을 때 짧은 쪽이 먼저 잘라 먹지 않게) */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of [...this.values].sort((a, b) => b[1].length - a[1].length)) out = out.split(value).join(secretPlaceholder(name));
    return out;
  }
}
