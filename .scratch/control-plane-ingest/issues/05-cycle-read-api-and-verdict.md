# 05: Cycle 조회 API 와 Verdict 계산

**What to build:** Cycle 을 만들고 그 아래 Run 을 등록하면, Ingest 로 들어온 결과를 모아 `GET /cycles/:id` 가 TestCase × 타깃 매트릭스와 spec 0001 의 Verdict 를 돌려준다. 규칙: TestCase × 타깃 최종 상태는 마지막 Attempt, 재시도로 통과하면 `passed-flaky`, 필수 태그 전부 통과해야 Cycle 은 `verified` 아니면 `blocked`, 아직 끝나지 않은 Run 이 있으면 `incomplete`. Console 이 바로 그릴 수 있는 JSON 이 목표(Console 구현은 범위 밖). Issue/waive 는 범위 밖이되 `waived` 자리는 비워 둔다.

**Blocked by:** 02 (Run/Attempt 투영)

**Status:** ready-for-agent

- [ ] `POST /cycles`(빌드 식별자, 타깃 목록, 필수 태그), `POST /cycles/:id/runs`(타깃 → runId 발급). 러너의 `run.started.cycleId/targetId` 가 이 id 와 맞물린다
- [ ] Verdict 계산은 순수 함수로 `packages/protocol` 또는 control-plane 의 순수 모듈에 두고 표 기반 테스트(마지막 Attempt 우선, flaky, blocked, skipped, 필수 태그, incomplete)
- [ ] `GET /cycles/:id` 가 Cycle 상태(`CYCLE_STATES`), 매트릭스(testId × targetId → `CaseVerdict` + 마지막 attemptId), `CycleVerdict` 를 돌려준다
- [ ] 모든 Run 이 `finished`/`infra-failed`/`cancelled` 면 Cycle 은 `finished` 로 전이되고 Verdict 가 고정된다. `infra-failed` Run 의 미실행 TestCase 는 `blocked`
- [ ] 통합 테스트: Cycle 생성 → Run 2개(타깃 2개) → 러너 FakeEngine 이벤트 Ingest(하나는 재시도 후 통과) → 매트릭스에 `passed-flaky` 가 보이고 Verdict 가 규칙대로
- [ ] `verify-ingest` 스킬에 Cycle feature 추가
