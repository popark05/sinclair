# 02: Ingest 엔드포인트와 멱등 이벤트 저장

**What to build:** control-plane 에 `POST /ingest` 가 생겨 Reporter 가 보낸 이벤트 배치를 받는다. 같은 `eventId` 를 몇 번 보내도 한 번만 저장되고, 배치가 뒤섞이거나 순서가 바뀌어 도착해도 Run/Attempt 투영(Run 상태, Attempt 결과·에러 코드·아티팩트, 스텝 목록)이 같다. `GET /runs/:id` 로 투영을 읽어 확인할 수 있다. 저장소는 인터페이스 뒤의 인메모리 구현으로 시작하고(04 에서 SQLite 로 교체), 저장소 인터페이스 테스트 스위트를 둔다.

**Blocked by:** 01 (이벤트 검증기)

**Status:** ready-for-agent

- [ ] `POST /ingest` 가 `RunEvent[]` 배치를 받아 01 의 검증기로 거르고, 응답에 `accepted`/`duplicate`/`rejected`(이유 포함) 수를 돌려준다. 하나가 잘못돼도 나머지는 저장된다
- [ ] 멱등: 같은 배치를 두 번 보내도 두 번째는 전부 `duplicate`, 투영은 바이트 단위로 같다
- [ ] 순서 무관: `attempt.finished` 가 `attempt.started` 보다 먼저 와도 최종 투영이 같다(순열 테스트)
- [ ] `GET /runs/:id` 가 Run 상태(`RUN_STATES`), Attempt 목록(testId, attemptNo, result, errorCode, artifacts, steps)을 돌려주고, 모르는 id 는 404
- [ ] 저장소 인터페이스 + 인메모리 구현 + 구현체 교체 가능한 공유 테스트 스위트(04 가 재사용)
- [ ] 러너의 FakeEngine 샘플 run 이 만든 실제 이벤트를 Ingest 에 넣고 `GET /runs/:id` 가 러너 `RunReport` 와 일치하는 통합 테스트
- [ ] `verify-ingest` 검증 스킬 시드: 서버를 띄워 배치 전송·중복 전송·조회를 curl 로 구동하고 증거를 남긴다
