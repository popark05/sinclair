# 04: runner `expect` 판정

**What to build:** `await expect(screen.getByRole('status')).toContainText('Pro')` 처럼 화면 상태를 기한 안에 폴링해 판정한다. 판정은 화면을 바꾸지 않는다.

**Blocked by:** 03 (locator)

**Status:** done

- [x] `toBeVisible/toBeHidden/toHaveText/toContainText/toHaveValue/toBeChecked/toBeDisabled/toHaveCount` 와 `.not`
- [x] 기한(기본 5초) 안에 재관찰하며 통과하는 순간 끝나고, 실패하면 마지막 관찰의 노드 요약과 기대/실제를 담은 메시지
- [x] 판정은 엔진의 `locate` 만 부르고 `perform` 을 부르지 않는다(FakeEngine 의 `performed` 가 비어 있음을 테스트로 고정)
- [x] `secure` 노드에 대한 `toHaveText/toHaveValue` 는 `secure-read` 로 거부된다
- [x] FakeEngine 으로 "잠시 뒤 바뀌는 값" 시나리오와 실패 메시지가 검증된다

## Comments

- 2026-11-07: 완료. `expect(locator, { timeoutMs = 5초, pollMs })` → `toBeVisible(정확히 하나)/toBeHidden(없음)/toHaveText/toContainText/toHaveValue/toBeChecked/toBeDisabled/toHaveCount` 와 `.not`. 기한 안 `locator.probe()`(대기 없는 조회, 03 에 추가) 폴링. 실패는 `AssertionError(matcher, expected, actual)` 에 "{질의} 가 {판정} 을 Nms 안에 만족하지 않음. 실제: … 마지막 관찰: {노드 요약 ≤5}". 단일 노드 판정에 둘 이상 맞으면 `ambiguous`(toHaveCount 안내), secure 노드의 text/value 판정은 `secure-read`. FakeEngine 테스트 7개(잠시 뒤 바뀌는 값, 돌아오는 화면, 실패 메시지, perform 미호출).
