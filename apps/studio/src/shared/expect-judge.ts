// 요소 판정(studio 09): 고른 노드의 질의로 하는 결정적 판정. 검사 종류 ↔ 러너 expect 메서드 ↔ 내보낼 코드를 한곳에서 —
// 렌더러(목록 표시)·작업 프로세스(지금 화면에서 실행)·내보내기가 같은 정의를 쓴다.
import { jsString } from './js-string.ts';

export const EXPECT_MATCHERS = {
  visible: { label: '보인다', method: 'toBeVisible', needsValue: false },
  hidden: { label: '안 보인다', method: 'toBeHidden', needsValue: false },
  text: { label: '글자가 같다', method: 'toHaveText', needsValue: true },
  contains: { label: '글자를 포함', method: 'toContainText', needsValue: true },
  value: { label: '값이 같다', method: 'toHaveValue', needsValue: true },
  checked: { label: '체크됨', method: 'toBeChecked', needsValue: false },
  disabled: { label: '비활성', method: 'toBeDisabled', needsValue: false },
} as const;
export type ExpectMatcher = keyof typeof EXPECT_MATCHERS;
export const isExpectMatcher = (v: unknown): v is ExpectMatcher => typeof v === 'string' && Object.hasOwn(EXPECT_MATCHERS, v);

/** 요소 판정의 질의: Inspector 후보가 만드는 모양만(testId · 역할+이름 · 글자 · placeholder, 정확 일치) */
export interface JudgeQuery { testId?: string; role?: string; name?: string; text?: string; placeholder?: string; exact?: boolean }
const STRING_KEYS = ['testId', 'role', 'name', 'text', 'placeholder'] as const;
const MAX = 500;

/** 렌더러에서 온 질의 검사: 아는 키만, 문자열 1~500자, exact 는 불리언, 찾을 근거(testId·역할·글자·placeholder) 하나 이상 */
export function parseLocatorQuery(v: unknown): JudgeQuery | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: JudgeQuery = {};
  for (const [k, val] of Object.entries(o)) {
    if (k === 'exact') { if (typeof val !== 'boolean') return undefined; out.exact = val; continue; }
    if (!(STRING_KEYS as readonly string[]).includes(k) || typeof val !== 'string' || !val || val.length > MAX) return undefined;
    out[k as (typeof STRING_KEYS)[number]] = val;
  }
  return out.testId || out.role || out.text || out.placeholder ? out : undefined;
}

/** 질의 → locator 코드(locators.ts 의 후보와 같은 모양). 우선순위 testId → 역할(+이름) → 글자 → placeholder */
export function locatorCode(q: JudgeQuery): string {
  const exact = q.exact ? ', exact: true' : '';
  if (q.testId) return `screen.getByTestId(${jsString(q.testId)})`;
  if (q.role) return `screen.getByRole(${jsString(q.role)}${q.name !== undefined ? `, { name: ${jsString(q.name)}${exact} }` : ''})`;
  if (q.text) return `screen.getByText(${jsString(q.text)}${q.exact ? ', { exact: true }' : ''})`;
  return `screen.getByPlaceholder(${jsString(q.placeholder ?? '')})`;
}

export function expectCode(locator: string, matcher: ExpectMatcher, expected?: string): string {
  const m = EXPECT_MATCHERS[matcher];
  return `expect(${locator}).${m.method}(${m.needsValue ? jsString(expected ?? '') : ''})`;
}
