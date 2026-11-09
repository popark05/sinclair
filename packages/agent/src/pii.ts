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

/** 주민등록번호 앞 6자리가 날짜 모양인가(송장·주문번호 13자리와 가르기) */
const birthLike = (d: string): boolean => { const m = Number(d.slice(2, 4)), day = Number(d.slice(4, 6)); return m >= 1 && m <= 12 && day >= 1 && day <= 31; };
/** 카드번호: 앞자리 3~6 과 길이(16, 아멕스 34·37 은 15) + 룬. 우연히 룬을 통과하는 긴 ID(약 10%)를 앞자리·길이로 거른다 */
const cardLike = (d: string): boolean => (d.length === 16 ? /^[3-6]/.test(d) : d.length === 15 && /^3[47]/.test(d)) && luhn(d);

// 순서가 뜻이 있다: 전화번호·주민등록번호를 먼저 바꿔야 긴 숫자열(카드번호) 검사가 그 숫자를 잘못 먹지 않는다. 자리표시에는 숫자가 없다.
// 모든 규칙은 왼쪽 경계(lookbehind)를 둔다 — 없으면 긴 글자열에서 시작 위치마다 끝까지 훑어 제곱 시간이 든다
const RULES: Array<[RegExp, (m: string, ...g: string[]) => string]> = [
  // 이메일(유니코드 이름·도메인). 화면이 가린 형태(qa*****@…)도 개인정보 단서라 같이
  [/(?<![\p{L}\p{N}._%+*-])[\p{L}\p{N}._%+*-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu, () => '<이메일>'],
  // 주민등록번호(외국인 등록번호 5~8 포함): 붙여 쓰거나 - 앞뒤 공백
  [/(?<!\d)(\d{6})(?:\s?-\s?|\s)?([1-8]\d{6})(?!\d)/g, (m, a = '') => (birthLike(a) ? '<주민등록번호>' : m)],
  // 국제 전화: + 국가번호, (0) 허용, 숫자 8~15개
  [/(?<![\d+])\+\d{1,3}(?:[-. ]?\(0\))?(?:[-. ]?\(?\d{1,4}\)?){2,4}(?!\d)/g, (m) => { const n = m.replace(/\D/g, '').length; return n >= 8 && n <= 16 ? '<전화번호>' : m; }],
  // 국내 휴대전화: 010 은 가운데 4자리, 그 밖 01x 는 3~4자리. 구분자 - . 공백 또는 없음. 가운데가 가려진 형태(****)도
  [/(?<![\d*-])(?:010[-. ]?[\d*]{4}|01[16789][-. ]?[\d*]{3,4})[-. ]?\d{4}(?![\d-])/g, () => '<전화번호>'],
  // 국내 유선: (02) 또는 0 지역번호 + 구분자 필수(날짜·버전·IP 와 섞이지 않게)
  [/(?<![\d-])(?:\(0(?:2|[3-6]\d)\)\s?|0(?:2|[3-6]\d|70|50\d)[-. ])[\d*]{3,4}[-. ]\d{4}(?![\d-])/g, () => '<전화번호>'],
  // 카드번호: 4-4-4-4(공백·-) 또는 붙여 쓴 15~16자리, 앞자리·길이·룬
  [/(?<![\d-])(?:\d{4}[ -]){3}\d{4}(?![\d-])|(?<![\d-])\d{15,16}(?!\d)/g, (m) => (cardLike(m.replace(/\D/g, '')) ? '<카드번호>' : m)],
  // IMEI: 15자리는 주문번호와 구별할 수 없어 "IMEI" 라벨 옆일 때만(룬)
  [/(IMEI[^\d]{0,5})(\d{15})(?!\d)/gi, (m, label = '', d = '') => (luhn(d) ? `${label}<IMEI>` : m)],
];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 이미 들어간 자리표시(<이메일>…)·비밀값 자리표시({{secret:…}})는 다시 건드리지 않는다 — 두 번 가려도 같고, 목록의 낱말이 자리표시를 망가뜨리지 않게 */
const PROTECTED = /(<(?:이메일|전화번호|주민등록번호|카드번호|IMEI|개인정보)>|\{\{secret:[^}]*\}\})/u;
const outside = (text: string, fn: (s: string) => string): string => text.split(PROTECTED).map((part, i) => (i % 2 ? part : fn(part))).join('');
/** 가려진 값의 흔적(추출 결과 검사용) */
export const PII_PLACEHOLDER = /<(?:이메일|전화번호|주민등록번호|카드번호|IMEI|개인정보)>/u;

export function createPiiFilter(options: PiiOptions = {}): PiiFilter {
  const enabled = options.enabled !== false;
  const terms = [...new Set((options.terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  // 라틴·숫자 낱말은 단어 경계와 대소문자 무시("Kim" 이 "Kimchi" 를 먹지 않게), 그 밖(한글 이름 등)은 글자 그대로
  const termRe = terms.length ? new RegExp(terms.flatMap((t) => [...new Set([t, t.normalize('NFC'), t.normalize('NFD')])]).map((t) => (/^[\x20-\x7e]+$/.test(t) ? `(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])` : escapeRe(t))).join('|'), 'giu') : undefined;
  const redact = (text: string): string => {
    if (!enabled || !text) return text;
    // 패턴 먼저(목록의 "010" 같은 낱말이 전화번호 감지를 깨지 않게), 그다음 목록 — 둘 다 자리표시 밖에서만
    let out = outside(text, (part) => RULES.reduce((acc, [re, to]) => acc.replace(re, (m, ...g: unknown[]) => to(m, ...(g.filter((x) => typeof x === 'string') as string[]))), part));
    if (termRe) out = outside(out, (part) => part.replace(termRe, '<개인정보>'));
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
