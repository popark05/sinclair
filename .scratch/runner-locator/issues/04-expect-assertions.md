# 04: runner `expect` 판정

**What to build:** `await expect(screen.getByRole('status')).toContainText('Pro')` 처럼 화면 상태를 기한 안에 폴링해 판정한다. 판정은 화면을 바꾸지 않는다.

**Blocked by:** 03 (locator)

**Status:** ready-for-agent

- [ ] `toBeVisible/toBeHidden/toHaveText/toContainText/toHaveValue/toBeChecked/toBeDisabled/toHaveCount` 와 `.not`
- [ ] 기한(기본 5초) 안에 재관찰하며 통과하는 순간 끝나고, 실패하면 마지막 관찰의 노드 요약과 기대/실제를 담은 메시지
- [ ] 판정은 엔진의 `observe/locate` 만 부르고 `perform` 을 부르지 않는다(계약 테스트로 고정)
- [ ] `secure` 노드에 대한 `toHaveText/toHaveValue` 는 `secure-read` 로 거부된다
- [ ] FakeEngine 으로 "잠시 뒤 바뀌는 값" 시나리오와 실패 메시지가 검증된다
