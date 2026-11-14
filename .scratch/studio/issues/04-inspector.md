# 04: Inspector — 화면 트리, 하이라이트, locator 후보

**What to build:** 오른쪽 Inspector 가 같은 스냅샷의 트리를 보여 주고(검색·접기), 트리 선택 ↔ 화면 하이라이트를 동기화하며, 선택 노드의 속성과 locator 후보(`getByRole`·`getByText`·`getByTestId`)를 현재 화면 매치 수와 함께 복사할 수 있게 한다.

**Blocked by:** 03

**Status:** done

- [x] 후보 생성은 runner locate 규칙과 같은 판정(매치 수 1 이 아니면 경고), 화면 클릭으로 노드 선택(가장 안쪽)
- [x] secure 노드 값은 보이지 않음
- [x] 테스트: 후보 생성·매치 수, 하이라이트 rect

## Comments

- 2026-11-14 구현. `inspector-model.ts`: locator 후보는 러너 `screen` 과 같은 질의 — testId → `getByRole(역할, { name, exact: true })` → `getByText(글자, { exact: true })`(이름 없고 secure 아닐 때) → `getByPlaceholder` — 를 만들고 매치 수는 protocol `locateInTree`(엔진과 같은 규칙)로 센다. 작은따옴표 이스케이프. `nodeAt`(점을 품은 가장 안쪽 노드, 겹치면 나중 것), `nodeProps`(secure 값은 가림), `treeLabel`(역할 "이름" · testId 끝).
- `Inspector`(astryx SegmentedControl·TreeList·MetadataList·List): 화면 트리(검색 — 맞는 노드와 조상만), 고른 노드의 속성(속성 탭) 또는 한 줄 요약(트리 탭), locator 후보 목록(현재 화면 N개, 1 이 아니면 "하나로 정해지지 않음"), 복사(클립보드). 후보를 못 만드는 노드는 안내.
- Device 패널: 고른 노드 rect(기기 픽셀)를 그림이 들어간 사각형·배율로 표시 좌표에 놓은 하이라이트(accent 토큰), 그림 로드·크기 변화 때 다시 놓음. 화면 클릭은 탭과 함께 그 자리의 가장 안쪽 노드를 고른다.
- 실기: 데몬 경유 SM-N981N 화면 트리가 Inspector 에 그려짐(캡처는 개인 화면이라 확인 뒤 지움). 하이라이트·클릭 선택은 단위 테스트로(배율·여백 계산 포함).
- 덤: agent `renderLedger` 성능 테스트가 전체 실행 부하에서 5초를 넘기던 것을 30초 기한으로.
- 남은 것: 스냅샷마다 트리를 다시 그린다(500ms) — 사용자가 접은 가지가 화면이 바뀌면 다시 펼쳐짐. 화면이 안 바뀌면 트리를 건너뛰는 최적화는 후속.
