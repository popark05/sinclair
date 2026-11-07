# Ingest 배치 저장과 조회

Reporter 가 보낸 `RunEvent[]` 배치가 eventId 로 멱등 저장되고, `GET /runs/:id` 가 이벤트에서 계산한 Run/Attempt 투영을 돌려준다.

## Sub-features

- `ingest-accept` 올바른 배치는 전부 `accepted`.
- `ingest-dup` 같은 배치 재전송은 전부 `duplicate`, 투영 불변.
- `ingest-order` 뒤섞어 나눠 보내도 투영이 같다.
- `ingest-reject` 잘못된 원소는 `rejected[]`(index, eventId, errors) 로, 나머지는 저장.
- `runs-get` 모르는 run 은 404, `GET /runs` 는 요약 목록.

## How to get to it (user POV)

러너가 `runTests(files, { reporter })` 로 돌 때 HTTP Reporter(티켓 03)가 이벤트를 배치로 `POST /ingest` 하고, Console 이 `GET /runs/:id` 로 결과를 본다.

## Driving it with scripts

```bash
$S/ingest.sh $RUN $S/sample-events.json first        # {"accepted":5,"duplicate":0,"rejected":[]}
$S/get.sh $RUN /runs/verify-run view-1
$S/ingest.sh $RUN $S/sample-events.json again        # {"accepted":0,"duplicate":5,"rejected":[]}
$S/get.sh $RUN /runs/verify-run view-2
diff <(node -p "JSON.stringify(require('./$RUN/evidence/view-1.json').response)") <(node -p "JSON.stringify(require('./$RUN/evidence/view-2.json').response)") && echo IDEMPOTENT
$S/ingest.sh $RUN '[{"schema":1,"eventId":"v-bad","runId":"verify-run","at":"2026-11-07T00:00:05.000Z","type":"attempt.finished","attemptId":"v-a1","artifacts":[]}, 42]' reject
# → rejected: [{index:0,eventId:"v-bad",errors:["result: 필수 필드 누락"]},{index:1,errors:["이벤트는 객체여야 함"]}]
$S/get.sh $RUN /runs/없음 missing                     # 404
$S/get.sh $RUN /runs list                             # [{runId:"verify-run",state:"finished",attempts:1,...}]
```

```bash
$S/order-check.sh $RUN $S/sample-events.json order    # ORDER-INDEPENDENT; evidence order-view-ordered/-shuffled 비교
```

## Gotchas

- 저장소가 인메모리라 서버를 내리면 사라진다. 한 RUN 안에서 증명한다.
- `at` 은 타임존이 있어야 한다(`Z` 또는 `+09:00`). 없으면 `rejected`.
- 중복 판정은 eventId 만 본다. 내용이 달라도 같은 id 면 처음 것이 남는다.
- 본문은 8 MB 상한(413). 큰 배치는 파일로 넘긴다(`ingest.sh` 는 항상 파일로 보낸다).
- 원소 거부는 HTTP 200 + `rejected[]` 다. 400 은 본문 전체가 JSON 배열이 아닐 때만.
