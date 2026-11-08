# 01: 테스트 재시도 — 실패한 테스트를 새 Attempt 로 다시 돌린다

**What to build:** 러너가 실패한 테스트를 앱을 다시 띄운 뒤 정해진 횟수만큼 다시 돌리고, 시도마다 새 Attempt(`attemptNo` 2, 3…)로 보고한다. 재시도 끝에 통과하면 Cycle 매트릭스의 그 셀이 `passed-flaky` 로, 끝내 실패하면 `failed` 로 집계된다(Verdict 규칙은 이미 `attemptNo` 최대를 본다). QA 담당자는 에이전트 `--retries` 또는 Cycle 의 `suite.retries` 로 횟수를 정한다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `runTests` 옵션 `retries`(기본 0). 실패(failed) 한 테스트만 재시도하고 blocked·skipped 는 하지 않는다. 재시도 전에 `session.restart`, 실패마다 아티팩트는 attempt 별로 남는다
- [ ] 이벤트: 같은 `testId` 로 `attempt.started(attemptNo n)` → … → `attempt.finished`; 리포트의 `TestResult` 는 마지막 Attempt 결과와 `attempts` 수를 담는다. `RunReport.summary` 는 마지막 결과 기준
- [ ] 에이전트 `--retries`/`SINCLAIR_AGENT_RETRIES`, 데몬은 Cycle 의 `suite.retries` 가 있으면 그것을 우선. control-plane `POST /cycles` 가 `suite.retries` 를 받는다(정수, 0~5)
- [ ] FakeEngine 테스트: 첫 시도 실패·두 번째 통과하는 시나리오(엔진이 n번째 시도에 화면을 바꾼다) → 리포트 `passed`/attempts 2, control-plane 조회에서 `passed-flaky`; 끝내 실패 → `failed` 와 attempts retries+1; blocked 는 재시도 안 함
- [ ] 실기기 증거: 의도적으로 첫 시도에 실패하도록 만든 샘플(예: 첫 시도에 없는 문구를 기다림 → 엔진 훅으로는 불가하니 테스트 파일이 시도 번호를 알 수 있게 fixture 에 `attemptNo` 노출)로 `passed-flaky` 셀 확인
