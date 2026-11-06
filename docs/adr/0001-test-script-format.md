# 0001. 테스트 스크립트 형식은 e2e 방식을 따른다

- 상태: 승인
- 날짜: 2026-11-07

## 맥락
결정적 산출물 형식으로 e2e(`test`/`expect`/`screen`/`agent`)와 mobilewright(Playwright Test 위 locator)를 비교했다.

## 결정
e2e 방식을 채택한다. mobilewright는 locator 해석의 모바일 세부 구현만 참고한다.

## 이유
mobilewright에는 에이전트 스텝, 판정, 녹화·재생이 없고 모바일 전용이다. 두 locator API는 외형이 거의 같아 전환 비용이 없다.
