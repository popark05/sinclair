# 03: 버려진 Run 정리와 대체 Run — 재클레임 규칙과 Cycle 재시도 한도

**What to build:** 에이전트가 run 도중 죽어 이벤트는 있는데 끝나지 않고 lease 가 만료된 Run 을 control-plane 이 "버려진 Run" 으로 보고, 유예 시간이 지나면 멱등한 합성 이벤트로 `infra-failed` 처리한다. Cycle 의 `retryLimit`(타깃당 대체 횟수, 기본 1) 안이면 같은 타깃의 **대체 Run** 을 자동 등록해 다음 클레임이 가져가게 한다. Verdict 는 대체된 Run 을 제외하고 대체 Run 을 본다. QA 담당자는 `GET /cycles/:id` 에서 어떤 Run 이 무엇으로 대체됐는지와 남은 한도를 본다. 지금은 이런 Cycle 이 영영 `incomplete` 로 남는다.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 버려짐 판정: 등록된 Run 에 이벤트가 있고 `run.finished` 가 없으며 lease 가 만료된 지 유예(기본 lease TTL 과 같은 60초, 이유 주석) 이상. 판정은 클레임·Cycle 조회 때 수행(별도 스케줄러 없음)
- [x] 합성 이벤트 `run.finished state=infra-failed` 를 `eventId = abandoned:<runId>` 로 Ingest 에 넣어 멱등(두 번 처리돼도 하나). 투영이 `infra-failed` 로 바뀌고 남은 케이스는 `blocked`
- [x] 대체 Run: `CycleRecord.retryLimit`(POST /cycles, 기본 1), 타깃별 사용 횟수를 넘지 않으면 `RunRegistration{ replaces: <runId> }` 를 등록. 끝난 Cycle 에는 하지 않는다. SQLite 레코드는 JSON 이라 마이그레이션 없음(확인)
- [x] Verdict: `replacedBy` 가 있는 Run 은 "모든 run finished" 판정과 매트릭스에서 제외(대체 Run 이 있을 때만). 대체 Run 이 또 버려지면 한도 안에서 반복, 한도를 넘으면 그대로 `infra-failed` 로 남아 Cycle `blocked`. spec 0001 "재시도 정책" 절 갱신
- [x] `GET /cycles/:id`: run 행에 `replaces`/`replacedBy`/`abandonedAt`, Cycle 에 `retryLimit` 과 타깃별 사용 횟수
- [x] 테스트: 시계 주입으로 (a) 유예 전에는 그대로, (b) 유예 뒤 조회 시 infra-failed + 대체 Run 등록, (c) 대체 Run 클레임·완료 → Cycle verified, (d) 한도 초과 → blocked, (e) 두 핸들/반복 호출에도 합성 이벤트·대체 Run 이 하나뿐(멱등)
- [x] `verify-ingest` 에 abandoned feature(시계는 서버 `now` 주입 대신 짧은 TTL 로)

## Comments

- 2026-11-08 구현(ed06e62 + 마무리 커밋). 결정: 유예 = lease TTL(60초, `--lease-ttl-ms`/`SINCLAIR_CP_LEASE_TTL_MS` 로 둘 다 바뀜); 대체 Run id 는 결정적 `retry:<runId>` 라 두 핸들·반복 호출에도 하나(`sweep.test.ts` SQLite 두 핸들 동시 호출). Verdict 에서 대체된 Run 의 케이스는 매트릭스에서 빠진다(blocked 가 아니라 대체 Run 이 채운다). SQLite 레코드는 JSON 이라 마이그레이션 없음(확인, schema 2 그대로).
- 증명: `verify-ingest` `abandoned.sh`(TTL 1초) → `ABANDONED OK`(리뷰 반영 뒤 .e2e/verify-ingest/20261108-133307-abandoned-review 에서 재통과, 대체 Run id `retry:<runId>`), 증거 `.e2e/verify-ingest/<ts>-abandoned/evidence/abandoned-*.json` 11개(유예 전 1개 → 정리 뒤 2개 → 재조회 그대로 → 대체 Run 클레임 → verified).
- 알려진 한계: 끝난 Cycle 검사는 sweep 대상이 "끝나지 않은 Run" 뿐이라 자연히 성립(끝난 Cycle 엔 미종료 Run 이 없다). sweep 은 Cycle 당 Run 수만큼 이벤트를 읽으므로 Cycle 이 수백 개 쌓이면 클레임마다 비용이 는다 — 끝난 Cycle 건너뛰기는 후속.
- 2026-11-08 리뷰 반영(Standards + Spec 두 축). (1) **lease 없는 Run 은 정리 대상에서 제외** — 승인된 seam 은 "마지막 이벤트 시각 기준" 이었으나 리뷰가 실제 위험을 짚었다: 서버가 아는 건 생산 시각 `at` 뿐이라 `run --run` 의 스풀이 60초 넘게 늦게 비워지는 정상 상황을 죽음으로 오판해 `run.finished` 가 둘인 Run 을 만든다(HTTP 테스트가 `at` 을 지금 시각으로 고쳐야 했던 게 증상). 그런 Run 은 그 에이전트가 끝까지 책임진다(spec·feature 갱신). (2) 등록 → 표시 순서로 바꾸고 대체 id 를 결정적 `retry:<runId>` 로: 둘 사이에 죽어도 다음 정리가 이어 붙인다(회귀 테스트 추가). (3) 클레임 핫패스 비용: lease 만료 검사(레코드)를 통과한 Run 만 이벤트를 읽는다. (4) `abandonedAt!` 제거, `DEFAULT_LEASE_TTL_MS` 단일 출처(http.ts), `ControlPlaneConfig.leaseTtlMs` 는 선택 유지(runner-agent 테스트가 설정 리터럴을 손으로 만든다), 미사용 `abandonGraceMs` 옵션 삭제, JSDoc 위치, `used` 카운터. 보류: 끝난 Cycle 명시적 건너뛰기(미종료 lease Run 이 없으면 자연히 비용 0 이라 불필요).
