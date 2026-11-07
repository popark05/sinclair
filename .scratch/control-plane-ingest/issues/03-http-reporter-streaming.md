# 03: HTTP Reporter — 러너에서 Ingest 로 스트리밍

**What to build:** 러너에 Ingest 로 보내는 Reporter 가 생겨, `runTests` 에 Ingest 주소를 주면 테스트가 도는 동안 이벤트가 배치로 전송된다. 전송이 실패하면 같은 `eventId` 로 재시도하고(멱등 덕분에 안전), 서버가 잠시 꺼져 있어도 버퍼에 모았다가 다시 보낸다. run 이 끝날 때 flush 가 모두 전송될 때까지 기다린다. 인프로세스로 Ingest 서버를 띄운 통합 테스트가 "러너 → Reporter → Ingest → 조회" 가 러너 리포트와 같음을 증명한다.

**Blocked by:** 01 (Reporter 훅), 02 (Ingest)

**Status:** done

- [x] HTTP Reporter: 배치 크기·간격·재시도 횟수·백오프 옵션, 상수마다 이유 주석
- [x] 일시적 실패(5xx, 연결 거부)는 재시도, 검증 거부(4xx `rejected`)는 재시도하지 않고 경고로 남긴다
- [x] 재시도로 같은 이벤트가 두 번 가도 Ingest 투영이 변하지 않는 테스트(서버가 첫 응답을 일부러 끊음)
- [x] 서버가 run 중간에 내려갔다 올라와도 flush 뒤 모든 이벤트가 저장된다
- [x] flush 가 기한 안에 못 끝나면 러너는 경고와 함께 리포트를 돌려주고 멈추지 않는다
- [x] 통합 테스트: FakeEngine 샘플 run → HTTP Reporter → 인프로세스 Ingest → `GET /runs/:id` 가 `RunReport` 와 일치
- [x] `verify-ingest` 스킬에 "러너에서 흘려보내기" feature 추가

## Comments

- 2026-11-07: 완료. `packages/runner/src/http-reporter.ts` `createHttpReporter({ url, batchSize 100, flushIntervalMs 500, backoffMs 500, maxBackoffMs 10s, fetch })` → `HttpReporter { onEvent, flush, warnings, stats, setUrl }`. onEvent 는 큐에 넣고 동기로 끝난다(러너 `pending` 누적 없음, 01 미결 해소). 배치 크기 또는 간격마다 `POST /ingest`, 한 번에 하나만 보내 순서 보존. 5xx·연결 오류는 같은 eventId 로 상한 있는 백오프를 두고 끝없이 재시도(기한은 러너 `reporterFlushTimeoutMs`), `rejected[]`·200 외 상태(400 등)는 재시도 없이 `warnings`. 러너 `Reporter.warnings`(선택) 를 flush 뒤 `RunReport.warnings` 에 합친다.
- 테스트: 러너 쪽 페이크 Ingest 7개(배치·순서, 간격, 5xx/끊김 재시도 같은 eventId, rejected/400 경고, 서버 내려갔다 올라옴(setUrl), 빈 큐 타이머 회귀, flush 중 유입) + 러너 warnings 병합 1개; control-plane 종단 2개(러너 → HTTP Reporter → 실제 Ingest → 투영 일치; Ingest 저장 뒤 응답을 끊는 프록시로 재전송 → duplicate 로 흡수, 스텝 중복 없음).
- 발견·수정한 버그: 간격 타이머가 배치 전송이 이미 끝난 뒤 빈 큐로 `drain()` 을 돌리면 async IIFE 가 동기로 끝나 `finally` 가 대입보다 먼저 실행되고, 끝난 promise 가 `draining` 에 남아 이후 flush 가 즉시 반환됐다(이벤트 유실). 빈 큐 조기 반환 + `draining === run` 가드로 고치고 회귀 테스트 추가.
- `verify-ingest` 에 `run-sample.sh`(FakeEngine 샘플 → HTTP Reporter → 띄운 Ingest) 와 `features/runner-stream.md` 추가. 구동 결과: 이벤트 10, sent/accepted 10, 경고 0, 투영 finished·attempts 3. evidence `03-http-reporter-latest.json`. 재전송 멱등은 프록시 테스트로 증명(스크립트 재현 없음).
- 03 문구 정정: "4xx 거부" 는 "`rejected[]` 와 200 외 응답(400 등)은 재시도 안 함, 5xx·연결 오류는 재시도" 로 구현.
- 2026-11-07 리뷰 반영(Standards + Spec): (1) `close()` 추가 — 백오프 대기·fetch 를 AbortController 로 깨고 남은 큐를 버리며 경고. 러너 `Reporter.close?()` 계약 추가, flush(기한 초과 포함) 뒤 호출. 영구 다운 서버에서 프로세스가 매달리지 않는다. (2) 생성 시 `new URL` 검증(설정 오류는 재시도 대상이 아님). (3) 413 은 배치를 반으로 쪼개 재전송, 1건도 넘으면 버리고 경고; 408/429 는 재시도. (4) 응답 모양이 다르면 경고로 처리(배치 유실·unhandled rejection 없음). (5) `setUrl` 제거, 서버 재기동 테스트는 같은 포트로 다시 띄움. (6) 빈 큐 타이머 회귀 테스트는 주입 fetch 로 완료 시점을 고정해 결정적. (7) 중복 전송 테스트는 같은 이벤트를 한 번만 넣은 별도 Ingest 의 투영과 바이트 단위 비교. (8) `warnings`/`stats` 를 readonly 로 노출. (9) Reporter 계약을 specs/0001 에 기록. 미반영(runner-agent 로): 디스크 스풀·재시도 상한, 큐 메모리 상한, 바이트 기준 배치 분할(413 분할로 대신), run 간 reporter 재사용 시 warnings/stats 누적(run 마다 새로 만든다).
