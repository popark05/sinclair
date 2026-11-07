# 러너에서 흘려보내기 (HTTP Reporter)

러너가 테스트를 도는 동안 `createHttpReporter` 가 이벤트를 배치로 `POST /ingest` 하고, run 이 끝나면 `GET /runs/:id` 가 러너 리포트와 같은 결과를 보여 준다.

## Sub-features

- `stream-complete` run 종료 뒤 모든 이벤트가 저장돼 있다(`stats.sent == events`, `accepted == events`).
- `stream-batching` batchSize 로 나뉘어 여러 요청으로 간다(`stats.sent` 는 같고 요청 수만 다름).
- `stream-retry-idempotent` 응답이 끊겨 재전송돼도 투영이 같다(테스트 `apps/control-plane/test/runner-http-reporter.test.ts` 가 프록시로 증명; 스크립트로는 재현하지 않는다).

## How to get to it (user POV)

runner-agent 가 `runTests(files, { engine, reporter: createHttpReporter({ url }) })` 로 테스트를 돌린다. Console 은 run 도중에도 `GET /runs/:id` 로 진행을 본다.

## Driving it with scripts

```bash
OUT=$($S/run-sample.sh $RUN 3)                       # FakeEngine 샘플(통과 1, 실패 1, skip 1)
RUNID=$(node -p "JSON.parse(process.argv[1]).runId" "$OUT")
$S/get.sh $RUN /runs/$RUNID stream-view              # state finished, attempts 3, cycleId verify-cycle
# stats.sent == events, accepted == events, warnings [] 를 evidence/run-sample.json 에서 확인
```

## Gotchas

- FakeEngine 샘플이라 엔진 동작은 증명되지 않는다(실기기는 `verify-runner`). 증명 대상은 Reporter → Ingest 경로다.
- Reporter 는 5xx·연결 오류를 끝없이 재시도한다. 서버가 없으면 러너의 `reporterFlushTimeoutMs`(기본 10초) 뒤 경고와 함께 끝난다.
