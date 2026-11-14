// 요소 판정(studio 09): 검사 종류 ↔ 러너 expect 메서드 ↔ 내보낼 코드, 질의 → locator 코드, 렌더러에서 온 질의 검사.
import { describe, it, expect } from 'vitest';
import { EXPECT_MATCHERS, expectCode, locatorCode, parseLocatorQuery } from '../src/shared/expect-judge.ts';

describe('expect-judge', () => {
  it('질의 → locator 코드(Inspector 후보와 같은 모양, 우선순위 testId → 역할+이름 → 글자 → placeholder)', () => {
    expect(locatorCode({ testId: 'com.app:id/go' })).toBe("screen.getByTestId('com.app:id/go')");
    expect(locatorCode({ role: 'button', name: "it's", exact: true })).toBe("screen.getByRole('button', { name: 'it\\'s', exact: true })");
    expect(locatorCode({ text: '창신동', exact: true })).toBe("screen.getByText('창신동', { exact: true })");
    expect(locatorCode({ placeholder: '검색' })).toBe("screen.getByPlaceholder('검색')");
  });

  it('검사 종류 → expect 코드(값이 있는 것만 인자)', () => {
    const loc = "screen.getByText('창신동', { exact: true })";
    expect(expectCode(loc, 'visible')).toBe(`expect(${loc}).toBeVisible()`);
    expect(expectCode(loc, 'contains', '종로')).toBe(`expect(${loc}).toContainText('종로')`);
    expect(expectCode(loc, 'value', "a'b")).toBe(`expect(${loc}).toHaveValue('a\\'b')`);
    expect(Object.keys(EXPECT_MATCHERS)).toEqual(['visible', 'hidden', 'text', 'contains', 'value', 'checked', 'disabled']);
  });

  it('렌더러에서 온 질의는 닫힌 모양만: 아는 키·문자열 길이·찾을 근거 하나 이상', () => {
    expect(parseLocatorQuery({ role: 'button', name: '로그인', exact: true })).toEqual({ role: 'button', name: '로그인', exact: true });
    expect(parseLocatorQuery({ text: '창신동' })).toEqual({ text: '창신동' });
    for (const bad of [{}, { exact: true }, { role: 'button', nth: 2 }, { text: 3 }, { text: 'x'.repeat(501) }, { testId: '' }, null, 'screen.getByText("x")', { name: '이름만' }]) expect(parseLocatorQuery(bad), JSON.stringify(bad)).toBeUndefined();
  });
});
