# 04: 종단 증명 — 죽은 데몬의 run 이 대체되고 재시도까지 거쳐 Cycle 이 verified 된다

**What to build:** `verify-runner-agent` 에 재시도 정책 전체를 한 번에 보이는 feature 를 더한다: 데몬을 run 도중 강제 종료 → lease 만료·유예 → control-plane 이 버려진 Run 을 infra-failed 처리하고 대체 Run 을 등록 → 다른 데몬이 클레임해 테스트 재시도(`retries`) 포함으로 끝내 Cycle 이 `verified` 가 되고 매트릭스에 `passed-flaky` 셀과 대체 사슬이 보인다. 한도를 넘기면 `blocked` 로 끝나는 경로도 같은 스크립트로.

**Blocked by:** 01 (테스트 재시도), 02 (취소 신호), 03 (버려진 Run·대체)

**Status:** done

- [x] 스크립트: 짧은 lease TTL 로 control-plane 기동 → Cycle(`retryLimit` 1, `suite.retries` 1) → 데몬 A 를 느린 FakeEngine 픽스처(첫 시도 실패·두 번째 통과하는 테스트 + 긴 테스트)로 띄우고 run 도중 SIGKILL → 유예 뒤 `GET /cycles/:id` 에 `infra-failed`+`replaces` → 데몬 B 가 대체 Run 을 끝냄 → `verified`, `passed-flaky`
- [x] 한도 초과 경로: `retryLimit` 0 인 Cycle 에서 같은 시나리오 → `blocked`, 대체 Run 없음
- [x] lease 상실 경로: 데몬 A 를 죽이지 않고 heartbeat 만 끊어(네트워크 차단 흉내) B 가 가져가게 → A 는 `cancelled` 로 끝나고 B 의 run 이 Verdict 에 쓰인다
- [x] 증거 `.scratch/retry-policy/evidence/04-e2e-latest.json` 에 세 경로의 상태·Verdict·대체 사슬
- [x] 실기기 1회: 재시도 샘플로 `passed-flaky` 가 실기기에서도 나오는 증거(01 의 샘플 재사용)

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 seam: (1) control-plane heartbeat — 대체된 Run 은 소유자여도 409 `replaced`, (2) `verify-runner-agent/scripts/retry-e2e.sh` + `retry-e2e.mjs` + `hb-proxy.mjs`(heartbeat 만 끊는 프록시), (3) 실기기는 01 의 재시도 샘플 재실행.
- 발견한 빈틈(03): 버려진 Run 으로 대체된 뒤에도 원래 에이전트의 heartbeat 가 성공해 lease 를 계속 연장했다. heartbeat 만 끊겼다 돌아온 에이전트는 not-owner 를 못 받아 02 의 취소가 걸리지 않았다. 저장소 outcome `replaced`(memory·SQLite) + HTTP 409 `code: replaced, replacedBy`, cycle-store 스위트·HTTP 테스트.
- 증명: `RETRY-E2E OK checks=10/10`(약 45초, TTL 2초, 긴 테스트 2초 × 7) — `.scratch/retry-policy/evidence/04-e2e-latest.json`. kill: 원래 Run infra-failed + `replacedBy retry:<runId>`, B 가 끝내 verified, retriesUsed 1, passed-flaky. limit: 대체 없이 infra-failed 하나, blocked, retriesUsed 0. lease: 프록시가 heartbeat 4회 차단, B 가 대체 Run 클레임 뒤 해제 → A 는 `not-owner`(409 replaced) → 긴 테스트 4개 skipped, run 코드 5, "lease 를 잃어 중단", 데몬 exit 0; Verdict 는 B 의 run 으로 verified.
- 관찰: lease 경로에서 원래 Run 의 저장된 상태는 `infra-failed`(합성 종료가 먼저)이고 A 의 `cancelled` 보고는 뒤에 들어와 상태를 바꾸지 않는다. spec·feature 에 명시.
- 개인정보: evidence 로그에 홈 디렉터리 경로가 들어가 있었다 — 실기기 `02-run-once-device-latest.json`·`02-run-once-retry-device-latest.json`(헬퍼 APK 경로)과 데몬(FakeEngine) `04-daemon-latest.json`(테스트 디렉터리 경로). 첫 커밋은 c7b3953, 원격 없음. 현재 파일은 `<repo>`/`<home>` 으로 지웠고 로그를 쓰는 곳(`run-once.device.test.ts`, `daemon.sh`, `retry-e2e.mjs`)이 모두 마스킹한다. 지난 커밋 이력에는 남아 있다.
- **남은 것(ready-for-human):** 실기기 1회. 재실행 시 기기가 보안 잠금 상태라 엔진 준비가 막혔다("기기 화면이 잠겨 있음"). 잠금 해제 뒤 `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/run-once.device.test.ts` 로 `02-run-once-retry-device-latest.json` 을 갱신하면 이 항목을 닫는다. 그 전까지는 01 에서 남긴 실기기 evidence(2026-11-08T04:48, passed-flaky 셀)가 같은 샘플의 증거다.
- 리뷰 반영(Standards + Spec). (1) 에이전트 `heartbeat()` 가 409 를 전부 not-owner 로 뭉쳐 e2e 가 replaced 를 증명하지 못함 → 본문 `code` 로 `replaced` 를 구분(lease 상실로 같이 다룸), 데몬 테스트 it.each 에 409 replaced 추가, e2e 는 로그 `: replaced` 를 확인. (2) `retry-e2e.sh`: 통과했을 때만 리포 증거 갱신, EXIT trap 으로 control-plane 정리, 리포 루트로 cd. (3) `hb-proxy.mjs`: 헤더 전송 뒤 상류 오류에 죽지 않게, SIGTERM 에 연결을 끊고 닫음; 부모는 프록시 종료를 기다리고 3초 뒤 SIGKILL. (4) 마스킹 일관화(e2e 에 홈 경로, `daemon.sh` 로그). (5) spec 문구 "먼저 들어간" → "at 이 가장 이른" + projection 테스트(run.finished 둘, 도착 순서 무관). (6) `EXPECTED_CHECKS` 상수, http.ts 중복 주석 삭제, 데몬 SIGTERM 로그를 idle 일 때 오해 없게, SQLite 저장소로 e2e 도는 방법을 Gotchas 에.
- 2026-11-08 실기기 완료: 잠금 해제 뒤 `run-once.device.test.ts` 통과(25.7초). SM-N981N(…XLZW): 설정 앱 샘플 Cycle verified(exit 0), 재시도 Cycle 은 attemptNo 1 failed → 2 passed, 매트릭스 셀 `passed-flaky`, verified(exit 0). 증거 `.scratch/runner-agent/evidence/02-run-once-device-latest.json`·`02-run-once-retry-device-latest.json`(06:17 UTC, 경로 마스킹 확인).
