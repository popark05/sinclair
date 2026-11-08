# 02: lease 를 잃으면 안전하게 멈춘다 — 러너 취소 신호

**What to build:** 데몬이 heartbeat 에서 `not-owner`(lease 만료 뒤 다른 에이전트가 가져감)를 받으면 러너에 취소 신호를 보내고, 러너는 진행 중인 테스트를 마친 뒤 남은 테스트를 `skipped` 로 끝내며 run 을 `cancelled` 상태로 보고한다. 두 에이전트가 같은 Run 에 계속 보고하던 창이 "현재 테스트 하나" 로 줄고, Cycle 뷰에 `cancelled` run 이 그대로 보인다(대체 Run 은 03).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `runTests` 옵션 `signal?: AbortSignal`. abort 되면 다음 테스트부터 시작하지 않고 `attempt.started/finished(skipped)` 로 남은 테스트를 기록, `run.finished state=cancelled`. 진행 중 테스트는 끝까지 간다(러너는 테스트 중간 중단을 지원하지 않음 — 명시)
- [x] 리포트에 `cancelled: { reason }`(사유 포함), 종료 코드는 에이전트에서 blocked(2) 가 아닌 별도 값(`EXIT.cancelled` 5)으로
- [x] 데몬: heartbeat `not-owner`/`no-run` 이면 abort → run 종료 뒤 로그 "lease 를 잃어 중단" → 다음 클레임으로 계속. 데몬 SIGTERM 도 같은 신호를 써서 "진행 중 테스트 하나만 마치고" 멈춘다(지금은 run 전체를 마침)
- [x] control-plane: `cancelled` run 의 케이스는 Verdict 에서 `blocked`(미실행)로 보이며 Cycle 은 `finished` 가 아니라 03 의 대체가 없으면 `blocked`
- [x] 테스트: FakeEngine 으로 세 테스트 중 두 번째 도중 abort → 결과 [passed, passed, skipped], run cancelled; 데몬 테스트에서 lease 를 다른 에이전트가 가져간 뒤 heartbeat not-owner → 중단 로그와 cancelled run

## Comments

- 2026-11-08 구현. 결정(승인된 seam): abort 되면 진행 중 테스트의 남은 재시도도 시작하지 않는다; SIGTERM 도 같은 취소 경로(run 전체가 아니라 테스트 하나 뒤 멈춤); 취소된 run 의 skipped 케이스는 Verdict 에서 `blocked`(안 돌기로 한 skip 과 구분). `cancelled` 는 `infra-failed` 보다 우선(사유가 더 구체적). 사유는 `signal.reason`(Error 면 message).
- 테스트: 러너 3개(둘째 도중 abort → [passed, passed, skipped] + cancelled 사유 + 이벤트 검증기; 재시도 중 abort → 남은 재시도 없음, 미리 abort → 전부 skipped; abort 안 되면 cancelled 없음), 데몬 2개(종료 신호 → 현재 테스트만 마치고 exit 5, Cycle blocked 와 셀 blocked; heartbeat 409 → "lease 를 잃어 중단" 로그, cancelled run, 다음 클레임 계속), control-plane HTTP 1개(cancelled run 의 skipped 케이스 blocked, Cycle finished/blocked).
- 알려진 한계: 진행 중 테스트는 끝까지 간다(러너의 중간 중단 미지원). 취소된 run 은 03 의 버려진 Run 이 아니라 자동 대체되지 않는다(spec 에 명시, 후속 후보). 실제 bin 으로 SIGTERM 증거는 04 종단 증명에서.
- 2026-11-08 리뷰 반영(Standards + Spec, Opus 로 재실행). (1) **must-fix**: 마지막 테스트 도중 신호가 와도 run 이 cancelled 가 돼 다 통과한 Cycle 이 blocked 가 되던 문제 → 실제로 못 돌린 테스트·재시도가 있을 때만 cancelled(`cutShort`), 회귀 테스트. (2) Verdict 가 취소된 run 의 모든 skipped(작성자 `test.skip` 포함)를 blocked 로 바꾸던 문제 → 러너가 취소로 시작 못한 테스트에 `errorCode: 'cancelled'` 를 붙이고 Verdict 는 그것만 blocked(이벤트 계약의 errorCode 는 자유 문자열이라 protocol 변경 없음; 상수는 러너·control-plane 에 따로 두고 runner-agent 테스트가 같음을 확인). (3) `DaemonSummary.runs[].cancelled` 는 run 이 실제로 중단됐을 때(코드 5)만. (4) 종료 코드 문서: `run` 은 5 를 내지 않으므로 RUN_HELP·스킬에서 데몬 내부 코드로 정정, 데몬 프로세스는 cancelled run 을 실패로 세지 않음(main.ts, DAEMON_HELP), 5 가 1·2 보다 우선함을 EXIT 주석에. (5) 테스트 추가: blocked 뒤 취소 → cancelled 우선, heartbeat 404(no-run) 도 409 와 같이 취소(it.each). (6) 낡은 문구: spec·verdict.ts 헤더의 "cancelled 는 쓰이지 않음" 을 Cycle 상태로 한정. 체크박스 `cancelled: true` → `{ reason }`. 보류: lease 를 다른 에이전트가 실제로 가져가는 경로의 취소는 04 종단 스크립트(lease 상실 경로)가 실제 bin 으로 증명한다.
- 리뷰 반영 중 발견: 러너가 테스트 파일을 `?sinclair-run=<runId>` 로 불러들여, 한 프로세스에서 같은 runId 로 다시 돌리면 캐시된 모듈이 돌아와 테스트가 0개 등록됐다(404 경우 테스트가 409 경우 뒤에서만 실패해 드러남). 불러들일 때마다 고유 키(randomUUID)로 바꾸고 회귀 테스트 추가.
