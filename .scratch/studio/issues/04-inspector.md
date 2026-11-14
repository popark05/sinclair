# 04: Inspector — 화면 트리, 하이라이트, locator 후보

**What to build:** 오른쪽 Inspector 가 같은 스냅샷의 트리를 보여 주고(검색·접기), 트리 선택 ↔ 화면 하이라이트를 동기화하며, 선택 노드의 속성과 locator 후보(`getByRole`·`getByText`·`getByTestId`)를 현재 화면 매치 수와 함께 복사할 수 있게 한다.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 후보 생성은 runner locate 규칙과 같은 판정(매치 수 1 이 아니면 경고), 화면 클릭으로 노드 선택(가장 안쪽)
- [ ] secure 노드 값은 보이지 않음
- [ ] 테스트: 후보 생성·매치 수, 하이라이트 rect
