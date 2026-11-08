# 03: 버려진 Run 정리와 대체 Run — 재클레임 규칙과 Cycle 재시도 한도

**What to build:** 에이전트가 run 도중 죽어 이벤트는 있는데 끝나지 않고 lease 가 만료된 Run 을 control-plane 이 "버려진 Run" 으로 보고, 유예 시간이 지나면 멱등한 합성 이벤트로 `infra-failed` 처리한다. Cycle 의 `retryLimit`(타깃당 대체 횟수, 기본 1) 안이면 같은 타깃의 **대체 Run** 을 자동 등록해 다음 클레임이 가져가게 한다. Verdict 는 대체된 Run 을 제외하고 대체 Run 을 본다. QA 담당자는 `GET /cycles/:id` 에서 어떤 Run 이 무엇으로 대체됐는지와 남은 한도를 본다. 지금은 이런 Cycle 이 영영 `incomplete` 로 남는다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 버려짐 판정: 등록된 Run 에 이벤트가 있고 `run.finished` 가 없으며 lease 가 만료된 지 유예(기본 lease TTL 과 같은 60초, 이유 주석) 이상. 판정은 클레임·Cycle 조회 때 수행(별도 스케줄러 없음)
- [ ] 합성 이벤트 `run.finished state=infra-failed` 를 `eventId = abandoned:<runId>` 로 Ingest 에 넣어 멱등(두 번 처리돼도 하나). 투영이 `infra-failed` 로 바뀌고 남은 케이스는 `blocked`
- [ ] 대체 Run: `CycleRecord.retryLimit`(POST /cycles, 기본 1), 타깃별 사용 횟수를 넘지 않으면 `RunRegistration{ replaces: <runId> }` 를 등록. 끝난 Cycle 에는 하지 않는다. SQLite 레코드는 JSON 이라 마이그레이션 없음(확인)
- [ ] Verdict: `replacedBy` 가 있는 Run 은 "모든 run finished" 판정과 매트릭스에서 제외(대체 Run 이 있을 때만). 대체 Run 이 또 버려지면 한도 안에서 반복, 한도를 넘으면 그대로 `infra-failed` 로 남아 Cycle `blocked`. spec 0001 "재시도 정책" 절 갱신
- [ ] `GET /cycles/:id`: run 행에 `replaces`/`replacedBy`/`abandonedAt`, Cycle 에 `retryLimit` 과 타깃별 사용 횟수
- [ ] 테스트: 시계 주입으로 (a) 유예 전에는 그대로, (b) 유예 뒤 조회 시 infra-failed + 대체 Run 등록, (c) 대체 Run 클레임·완료 → Cycle verified, (d) 한도 초과 → blocked, (e) 두 핸들/반복 호출에도 합성 이벤트·대체 Run 이 하나뿐(멱등)
- [ ] `verify-ingest` 에 abandoned feature(시계는 서버 `now` 주입 대신 짧은 TTL 로)
