// 화면 개인정보 가림: 모델에 가는 화면 글자와 러너의 기록에서 개인정보를 종류 자리표시로 바꾼다.
// 패턴으로 찾는 것(이메일·전화번호·주민등록번호·카드번호·IMEI)은 자동, 이름·계정명처럼 패턴으로 못 찾는 것은 사람이 준 목록(terms)으로.
// 비밀값(secrets.ts)과 달리 값을 모르므로 모양으로 찾는다 — 패턴에도 목록에도 없는 이름·주소는 그대로 간다(한계).
// 가림은 직렬화 전 구조의 문자열 잎에 한다(redactDeep·redactTree): 직렬화한 글에 하면 숫자·키를 건드리고 이스케이프된 값을 놓친다.
import type { SemanticNode } from '@sinclair/protocol';
import { ModelConfigError } from './executor.ts';

export interface PiiOptions {
  /** 기본 true */
  enabled?: boolean;
  /** 패턴으로 못 찾는 개인정보(기기 소유자 이름·계정명 등). 글자 그대로 일치하는 곳을 `<개인정보>` 로 */
  terms?: readonly string[];
}

export interface PiiFilter {
  readonly enabled: boolean;
  redact(text: string): string;
  redactDeep<T>(value: T): T;
  redactTree(root: SemanticNode): SemanticNode;
}

/** 문자열 잎만 바꾼다(키·숫자·불리언·바이트는 그대로) */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return fn(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object' && !(x instanceof Uint8Array)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(value) as T;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// 순서가 뜻이 있다: 전화번호·주민등록번호를 먼저 바꿔야 긴 숫자열(카드번호) 검사가 그 숫자를 잘못 먹지 않는다. 자리표시에는 숫자가 없다
const RULES: Array<[RegExp, (m: string) => string | undefined]> = [
  // 이메일. 화면이 가린 형태(qa*****@example.com)도 개인정보 단서라 같이
  [/[A-Za-z0-9._%+*-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, () => '<이메일>'],
  // 주민등록번호(외국인 등록번호 5~8 포함)
  [/(?<!\d)\d{6}-[1-8]\d{6}(?!\d)/g, () => '<주민등록번호>'],
  // 국제 전화: + 로 시작, 숫자 8~15개
  [/\+\d[\d -]{6,18}\d(?!\d)/g, (m) => { const n = m.replace(/\D/g, '').length; return n >= 8 && n <= 15 ? '<전화번호>' : undefined; }],
  // 국내 휴대전화(구분자 있어도 없어도)
  [/(?<![\d-])01[016789]-?\d{3,4}-?\d{4}(?![\d-])/g, () => '<전화번호>'],
  // 국내 유선(구분자 필수 — 날짜·버전과 섞이지 않게 0 으로 시작하는 지역번호만)
  [/(?<![\d-])0(?:2|[3-6]\d|70|50\d)-\d{3,4}-\d{4}(?![\d-])/g, () => '<전화번호>'],
  // 카드번호(13~19자리, 공백·- 구분 허용)·IMEI(15자리 붙여 씀) — 둘 다 룬 검사를 통과할 때만(주문번호·바코드와 가르기)
  [/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return undefined;
    return digits.length === 15 && digits === m ? '<IMEI>' : '<카드번호>';
  }],
];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createPiiFilter(options: PiiOptions = {}): PiiFilter {
  const enabled = options.enabled !== false;
  const terms = [...new Set((options.terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  const termRe = terms.length ? new RegExp(terms.flatMap((t) => [t, t.normalize('NFC'), t.normalize('NFD')]).map(escapeRe).join('|'), 'g') : undefined;
  const redact = (text: string): string => {
    if (!enabled || !text) return text;
    let out = termRe ? text.replace(termRe, '<개인정보>') : text;
    for (const [re, to] of RULES) out = out.replace(re, (m) => to(m) ?? m);
    return out;
  };
  return {
    enabled,
    redact,
    redactDeep: (v) => (enabled ? mapStrings(v, redact) : v),
    redactTree: (root) => (enabled ? mapStrings(root, redact) : root),
  };
}

/** 기본 필터(패턴만). 목록이 필요하면 createPiiFilter({ terms }) */
export const DEFAULT_PII = createPiiFilter();

/** 환경변수 → 필터: SINCLAIR_AGENT_PII=off 면 끔, SINCLAIR_AGENT_PII_TERMS 는 쉼표로 나눈 목록 */
export function piiFromEnv(env: Record<string, string | undefined> = process.env): PiiFilter {
  const mode = env.SINCLAIR_AGENT_PII;
  if (mode && mode !== 'on' && mode !== 'off') throw new ModelConfigError(`SINCLAIR_AGENT_PII=${JSON.stringify(mode)}: on 또는 off 여야 함`);
  return createPiiFilter({ enabled: mode !== 'off', terms: (env.SINCLAIR_AGENT_PII_TERMS ?? '').split(',') });
}
