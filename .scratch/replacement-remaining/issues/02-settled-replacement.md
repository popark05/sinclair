# 02: 대체 Run 은 돌지 못한 케이스만 — settled 와 Verdict 이어받기

**What to build:** 버려지거나 취소된 Run 의 대체 Run 등록에 `settled`(대체 사슬에서 결과가 확정된 testId: 마지막 끝난 시도가 passed·passed-flaky 이거나 작성자 skipped). failed 는 확정이 아니다(죽어 가던 환경의 실패일 수 있고 남은 재시도를 못 했을 수 있다) — 다시 돈다. 클레임 응답에 `skipTests`. Verdict 는 대체된 Run 의 끝난 시도도 사슬 순서로 이어받는다(뒤 Run 이 덮고, 앞에서 failed 뒤 통과면 passed-flaky). 대체된 Run 의 "돌지 못함"(blocked·취소 skipped)은 이어받지 않는다.

**Blocked by:** —

**Status:** done
