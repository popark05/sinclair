# 02: Ingest 엔드포인트와 멱등 이벤트 저장

**What to build:** control-plane 에 `POST /ingest` 가 생겨 Reporter 가 보낸 이벤트 배치를 받는다. 같은 `eventId` 를 몇 번 보내도 한 번만 저장되고, 배치가 뒤섞이거나 순서가 바뀌어 도착해도 Run/Attempt 투영(Run 상태, Attempt 결과·에러 코드·아티팩트, 스텝 목록)이 같다. `GET /runs/:id` 로 투영을 읽어 확인할 수 있다. 저장소는 인터페이스 뒤의 인메모리 구현으로 시작하고(04 에서 SQLite 로 교체), 저장소 인터페이스 테스트 스위트를 둔다.

**Blocked by:** 01 (이벤트 검증기)

**Status:** done

- [x] `POST /ingest` 가 `RunEvent[]` 배치를 받아 01 의 검증기로 거르고, 응답에 `accepted`/`duplicate`/`rejected`(이유 포함) 수를 돌려준다. 하나가 잘못돼도 나머지는 저장된다
- [x] 멱등: 같은 배치를 두 번 보내도 두 번째는 전부 `duplicate`, 투영은 바이트 단위로 같다
- [x] 순서 무관: `attempt.finished` 가 `attempt.started` 보다 먼저 와도 최종 투영이 같다(순열 테스트)
- [x] `GET /runs/:id` 가 Run 상태(`RUN_STATES`), Attempt 목록(testId, attemptNo, result, errorCode, artifacts, steps)을 돌려주고, 모르는 id 는 404
- [x] 저장소 인터페이스 + 인메모리 구현 + 구현체 교체 가능한 공유 테스트 스위트(04 가 재사용)
- [x] 러너의 FakeEngine 샘플 run 이 만든 실제 이벤트를 Ingest 에 넣고 `GET /runs/:id` 가 러너 `RunReport` 와 일치하는 통합 테스트
- [x] `verify-ingest` 검증 스킬 시드: 서버를 띄워 배치 전송·중복 전송·조회를 curl 로 구동하고 증거를 남긴다

## Comments

- 2026-11-07: 완료. `apps/control-plane/src`: `store.ts`(`EventStore { append → accepted|duplicate, eventsForRun, runIds }` + 인메모리, structuredClone 으로 격리), `projection.ts`(`projectRun(events)` 순수 함수: 투영은 저장하지 않고 조회 시 계산, 정렬은 at/stepIndex/attemptId 같은 내용으로만 해 도착 순서 무관), `ingest.ts`(`ingestBatch`: 원소마다 `parseRunEvent`, 거부는 index/eventId/errors, 나머지는 저장), `http.ts`(`serveControlPlane(store)`: POST /ingest, GET /runs, GET /runs/:id, GET /health, 127.0.0.1, 인증 없음). 테스트 18개: 투영(완료 run, 첫 attempt 5개 전수 순열 + 전체 역순, running/queued/미완 attempt/infra-failed), 저장소 공유 스위트(`test/event-store-suite.ts`, 04 가 재사용), HTTP(멱등 바이트 동일, 부분 거부, 400/404, 뒤섞인 두 배치), 러너 FakeEngine → ingest → 조회가 RunReport 와 일치. `@sinclair/runner` 는 devDependency(`runner ← apps` 정방향).
- `verify-ingest` 스킬 시드(start/doctor/ingest/get/stop + sample-events.json, features/ingest-batch.md). 인메모리 모드로 1회 구동: accepted 5 → duplicate 5, 투영 바이트 동일, rejected 2건(index/eventId/errors), 404, 목록. evidence `evidence/02-ingest-latest.json`.
- 결정: Run 상태는 run.started 전 `queued`, 그 뒤 `running`, run.finished 의 state 로 끝. attempt.started 없이 온 스텝·종료도 attemptId 로 모은다(testId 비움). 중복 판정은 eventId 만(내용이 달라도 처음 것 유지).
