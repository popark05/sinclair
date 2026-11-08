// 비밀값 묶음: 모델은 자리표시 {{secret:이름}} 만 보고, 엔진에 입력하는 순간에만 실제 값으로 바꾼다.
// 값이 화면(secure 가 아닌 칸)·오류 문구로 되돌아오면 값 일치로 다시 자리표시로 가린다.
// 가림은 직렬화하기 전의 문자열에 한다(redactDeep·redactTree). 이미 직렬화된 글에 하면 이스케이프된 값("·\·줄바꿈)을 놓치고
// 숫자처럼 보이는 값이 키·숫자를 바꿔 JSON 을 깬다. 자유 문장(오류 문구)에는 이스케이프된 표현과 NFC/NFD 정규형까지 함께 가린다.
import type { SemanticNode } from '@sinclair/protocol';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** 이보다 짧은 값은 가림이 다른 글자(숫자·단어)까지 바꿔 기록을 망가뜨리고, 가려도 지키는 것이 거의 없다 */
export const MIN_SECRET_LENGTH = 4;
const PLACEHOLDER = /\{\{secret:([^}]*)\}\}/g;

export const secretPlaceholder = (name: string): string => `{{secret:${name}}}`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 문장 안에 나타날 수 있는 값의 표현들: 원래 값, JSON 이스케이프(오류 문구의 JSON.stringify), 유니코드 정규형 */
function formsOf(value: string): string[] {
  const forms = new Set<string>();
  for (const v of [value, value.normalize('NFC'), value.normalize('NFD')]) { forms.add(v); forms.add(JSON.stringify(v).slice(1, -1)); }
  return [...forms].filter((f) => f.length > 0);
}

export class SecretBox {
  private readonly values = new Map<string, string>();
  private pattern: RegExp | undefined;
  private byForm = new Map<string, string>();

  constructor(entries: Iterable<readonly [string, string]> = []) {
    for (const [name, value] of entries) this.add(name, value);
  }

  /** 이름은 대문자·숫자·_ (자리표시를 모델이 그대로 옮겨 쓰기 쉽고, 다른 문법과 섞이지 않게) */
  add(name: string, value: string): void {
    if (!SECRET_NAME.test(name)) throw new Error(`비밀값 이름 ${JSON.stringify(name)}: 대문자로 시작하는 대문자·숫자·_ 64자 이내여야 함`);
    if (value.length < MIN_SECRET_LENGTH) throw new Error(`비밀값 ${name} 이 ${MIN_SECRET_LENGTH}자보다 짧음(짧은 값은 기록에서 안전하게 가릴 수 없다)`);
    this.values.set(name, value);
    // 모든 값의 모든 표현을 긴 것부터 하나의 정규식으로: 한 번에 바꾸므로 앞서 넣은 자리표시 안을 다시 훑지 않는다
    this.byForm = new Map();
    for (const [n, v] of this.values) for (const f of formsOf(v)) if (!this.byForm.has(f) || this.values.get(this.byForm.get(f)!)!.length < v.length) this.byForm.set(f, n);
    this.pattern = new RegExp([...this.byForm.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
  }

  get size(): number { return this.values.size; }
  has(name: string): boolean { return this.values.has(name); }
  names(): string[] { return [...this.values.keys()]; }

  /** 글에 나온 자리표시 이름들 */
  static mentioned(text: string): string[] { return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!); }
  mentions(text: string): boolean { return SecretBox.mentioned(text).length > 0; }

  /** 자리표시를 실제 값으로. allowed 가 있으면 그 이름만(목표에 주어진 것·이 테스트가 등록한 것). 하나라도 안 되면 바꾸지 않고 사유를 돌려준다 */
  reveal(text: string, allowed?: ReadonlySet<string>): { ok: true; text: string } | { ok: false; error: string } {
    const bad = SecretBox.mentioned(text).filter((n) => !this.values.has(n) || (allowed && !allowed.has(n)));
    if (bad.length) return { ok: false, error: `쓸 수 없는 비밀값: ${[...new Set(bad)].join(', ')} — 목표에 주어진 자리표시만 쓸 수 있음` };
    return { ok: true, text: text.replace(PLACEHOLDER, (_, n: string) => this.values.get(n)!) };
  }

  /** 문장의 실제 값(모든 표현)을 자리표시로, 한 번에 */
  redact(text: string): string {
    if (!this.pattern) return text;
    return text.replace(this.pattern, (m) => secretPlaceholder(this.byForm.get(m)!));
  }

  /** 객체의 문자열 잎만 가린다(키·숫자·불리언은 그대로). 직렬화 전에 쓴다 */
  redactDeep<T>(v: T): T {
    if (!this.pattern) return v;
    const walk = (x: unknown): unknown => {
      if (typeof x === 'string') return this.redact(x);
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object' && !(x instanceof Uint8Array)) return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
      return x;
    };
    return walk(v) as T;
  }

  redactTree(root: SemanticNode): SemanticNode { return this.redactDeep(root); }
}
