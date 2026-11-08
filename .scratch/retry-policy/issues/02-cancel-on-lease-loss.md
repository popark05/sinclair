# 02: lease 를 잃으면 안전하게 멈춘다 — 러너 취소 신호

**What to build:** 데몬이 heartbeat 에서 `not-owner`(lease 만료 뒤 다른 에이전트가 가져감)를 받으면 러너에 취소 신호를 보내고, 러너는 진행 중인 테스트를 마친 뒤 남은 테스트를 `skipped` 로 끝내며 run 을 `cancelled` 상태로 보고한다. 두 에이전트가 같은 Run 에 계속 보고하던 창이 "현재 테스트 하나" 로 줄고, Cycle 뷰에 `cancelled` run 이 그대로 보인다(대체 Run 은 03).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `runTests` 옵션 `signal?: AbortSignal`. abort 되면 다음 테스트부터 시작하지 않고 `attempt.started/finished(skipped)` 로 남은 테스트를 기록, `run.finished state=cancelled`. 진행 중 테스트는 끝까지 간다(러너는 테스트 중간 중단을 지원하지 않음 — 명시)
- [x] 리포트에 `cancelled: true` 와 사유, 종료 코드는 에이전트에서 blocked(2) 가 아닌 별도 값(`EXIT.cancelled` 5)으로
- [x] 데몬: heartbeat `not-owner`/`no-run` 이면 abort → run 종료 뒤 로그 "lease 를 잃어 중단" → 다음 클레임으로 계속. 데몬 SIGTERM 도 같은 신호를 써서 "진행 중 테스트 하나만 마치고" 멈춘다(지금은 run 전체를 마침)
- [x] control-plane: `cancelled` run 의 케이스는 Verdict 에서 `blocked`(미실행)로 보이며 Cycle 은 `finished` 가 아니라 03 의 대체가 없으면 `blocked`
- [x] 테스트: FakeEngine 으로 세 테스트 중 두 번째 도중 abort → 결과 [passed, passed, skipped], run cancelled; 데몬 테스트에서 lease 를 다른 에이전트가 가져간 뒤 heartbeat not-owner → 중단 로그와 cancelled run

## Comments

- 2026-11-08 구현. 결정(승인된 seam): abort 되면 진행 중 테스트의 남은 재시도도 시작하지 않는다; SIGTERM 도 같은 취소 경로(run 전체가 아니라 테스트 하나 뒤 멈춤); 취소된 run 의 skipped 케이스는 Verdict 에서 `blocked`(안 돌기로 한 skip 과 구분). `cancelled` 는 `infra-failed` 보다 우선(사유가 더 구체적). 사유는 `signal.reason`(Error 면 message).
- 테스트: 러너 3개(둘째 도중 abort → [passed, passed, skipped] + cancelled 사유 + 이벤트 검증기; 재시도 중 abort → 남은 재시도 없음, 미리 abort → 전부 skipped; abort 안 되면 cancelled 없음), 데몬 2개(종료 신호 → 현재 테스트만 마치고 exit 5, Cycle blocked 와 셀 blocked; heartbeat 409 → "lease 를 잃어 중단" 로그, cancelled run, 다음 클레임 계속), control-plane HTTP 1개(cancelled run 의 skipped 케이스 blocked, Cycle finished/blocked).
- 알려진 한계: 진행 중 테스트는 끝까지 간다(러너의 중간 중단 미지원). 취소된 run 은 03 의 버려진 Run 이 아니라 자동 대체되지 않는다(spec 에 명시, 후속 후보). 실제 bin 으로 SIGTERM 증거는 04 종단 증명에서.
