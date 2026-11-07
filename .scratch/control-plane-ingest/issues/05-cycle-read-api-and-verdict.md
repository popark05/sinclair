# 05: Cycle 조회 API 와 Verdict 계산

**What to build:** Cycle 을 만들고 그 아래 Run 을 등록하면, Ingest 로 들어온 결과를 모아 `GET /cycles/:id` 가 TestCase × 타깃 매트릭스와 spec 0001 의 Verdict 를 돌려준다. 규칙: TestCase × 타깃 최종 상태는 마지막 Attempt, 재시도로 통과하면 `passed-flaky`, 필수 태그 전부 통과해야 Cycle 은 `verified` 아니면 `blocked`, 아직 끝나지 않은 Run 이 있으면 `incomplete`. Console 이 바로 그릴 수 있는 JSON 이 목표(Console 구현은 범위 밖). Issue/waive 는 범위 밖이되 `waived` 자리는 비워 둔다.

**Blocked by:** 02 (Run/Attempt 투영)

**Status:** done

- [x] `POST /cycles`(빌드 식별자, 타깃 목록, 필수 태그), `POST /cycles/:id/runs`(타깃 → runId 발급). 러너의 `run.started.cycleId/targetId` 가 이 id 와 맞물린다
- [x] Verdict 계산은 순수 함수로 `packages/protocol` 또는 control-plane 의 순수 모듈에 두고 표 기반 테스트(마지막 Attempt 우선, flaky, blocked, skipped, 필수 태그, incomplete)
- [x] `GET /cycles/:id` 가 Cycle 상태(`CYCLE_STATES`), 매트릭스(testId × targetId → `CaseVerdict` + 마지막 attemptId), `CycleVerdict` 를 돌려준다
- [x] 모든 Run 이 `finished`/`infra-failed`/`cancelled` 면 Cycle 은 `finished` 로 전이되고 Verdict 가 고정된다. `infra-failed` Run 의 미실행 TestCase 는 `blocked`
- [x] 통합 테스트: Cycle 생성 → Run 2개(타깃 2개) → 러너 FakeEngine 이벤트 Ingest(하나는 재시도 후 통과) → 매트릭스에 `passed-flaky` 가 보이고 Verdict 가 규칙대로
- [x] `verify-ingest` 스킬에 Cycle feature 추가

## Comments

- 2026-11-07: 구현 진행(사용 한도로 중단, 커밋 완료). 완료: `cycle-store.ts`(`CycleStore` 인터페이스 + 메모리), SQLite 1→2 마이그레이션(`cycles`, `cycle_runs`, `MIGRATIONS` 단계 배열, `openSqlite` 로 EventStore/CycleStore 가 한 핸들 공유), `verdict.ts`(`computeCycle`, `tagsOf`: 테스트 이름의 `@태그`, 케이스 집합 = run 들의 testId 합집합, infra-failed 미실행 → blocked, finished 미실행 → skipped, 마지막 attempt 는 attemptNo 최대, passed-flaky, draft/running/finished, incomplete/verified/blocked), HTTP `POST /cycles`(400/409), `GET /cycles`, `GET /cycles/:id`, `POST /cycles/:id/runs`(타깃 검사, 404/409), `RunSummary.cycleId`. 테스트: verdict 표 16개, CycleStore 공유 스위트(메모리·SQLite) + 마이그레이션 2개, Cycle API 3개(러너 FakeEngine 이벤트 + 손으로 만든 재시도 run → passed-flaky, verified). `pnpm check` 녹색.
- 남은 것: (1) `verify-ingest` 에 Cycle feature(`cycle.sh` + `features/cycle.md`)와 evidence `05-cycle-latest.json`. (2) 두 축 코드 리뷰 + 반영. (3) CLAUDE.md 작업 로그에 control-plane-ingest 시리즈 완료 기록. (4) specs/0001 에 태그 관례(`@tag`)와 미실행 케이스 규칙 기록.
- 2026-11-07: 마무리. `verify-ingest` 에 `cycle.sh`(Cycle 생성 → android/ios Run 등록 → android 통과·ios 재시도 통과 이벤트 → 중간/최종 조회)와 `features/cycle.md`. 구동 증거 `05-cycle-latest.json`: 생성 201, 등록 201·201, 중간 running/incomplete, 최종 finished/verified, ios 셀 passed-flaky(attemptId ios-a2). specs/0001 에 Verdict 세부 규칙(attemptNo, 합집합, blocked/skipped, @태그, 상태 전이)과 CLAUDE.md 작업 로그 갱신.
- 2026-11-07 리뷰 반영(Standards + Spec): (1) "Verdict 고정" 은 저장이 아니라 "조회마다 재계산 + 끝난 Cycle 에 Run 등록 불가(409)" 로 정의하고 spec 에 그렇게 기록. (2) `run.started` 의 cycleId/targetId 가 등록과 다르면 `CycleView.warnings` 로 드러냄(판정은 등록 기준) + 테스트. (3) 조회 조립을 `cycle-view.ts`(`buildCycleView`) 로 분리(HTTP 가 아닌 서비스 모듈, Console 재사용). (4) 잘못된 경로 인코딩은 400. (5) infra-failed → blocked 를 HTTP 수준에서도 테스트. (6) 같은 타깃 run 여럿은 뒤 등록이 덮는 규칙을 spec 과 테스트에 추가. (7) `SQLITE_MIGRATIONS` export 로 마이그레이션 테스트의 DDL 중복 제거. ADR 0004 를 버전 2·단계 배열로 갱신, GLOSSARY 에 TestCase/타깃/필수 태그, triage-labels 에 `done`, spec 에 expired/cancelled/waived 미사용과 Suite 필터 후속 메모. `cycle.sh` id 에 epoch 추가, 인용 일관. Console 후속 메모: 매트릭스 셀에 runId/errorCode, run 별 시각, 집계 수.
