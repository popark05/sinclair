# 서버가 없어도 이벤트를 잃지 않는다 (스풀·resume)

`sinclair-agent run` 의 기본 Reporter 는 디스크 스풀이다. control-plane 이 내려가 있으면 이벤트가 `<spool>/<runId>.jsonl` 에 남고, `sinclair-agent resume` 이 같은 eventId 로 이어 보낸 뒤 파일을 지운다.

## Sub-features

- `spool-written` 서버가 없어도 run 은 끝나고(exit 는 테스트 결과대로) 스풀에 `.jsonl`/`.meta.json` 이 남으며 출력에 "미전송 N건 … resume" 경고.
- `spool-resume` 서버를 올린 뒤 `resume` 이 "완료 (ack 0 → N)" 를 찍고 exit 0(미완 run 이 남으면 4), 스풀 비움, `GET /runs/:id` 가 finished.
- `spool-partial` 깨진 마지막 줄은 건너뛰고 경고(단위 테스트 `spool.test.ts` 로 증명).

## How to get to it (user POV)

기기 노드에서 run 을 돌리는 중 사내 control-plane 이 재배포되거나 네트워크가 끊겨도, 나중에 `sinclair-agent resume` 한 번으로 결과가 Console 에 올라간다.

## Driving it with scripts

```bash
$S/spool-resume.sh $RUN
# RUN exit=0 spool=[run-….jsonl run-….meta.json ]
# RESUME exit=0 spool=[] run.state=finished
```

## Gotchas

- 스크립트가 서버를 내렸다 같은 포트로 다시 올린다. memory 모드면 Cycle/Run 등록은 사라지지만 Ingest 는 runId 를 검사하지 않아 `GET /runs/:id` 로 확인한다(`GET /cycles/:id` 는 404). sqlite 모드(`SINCLAIR_INGEST_STORE=sqlite`)면 Cycle 도 남는다.
- 재시도 예산(기본 60초)이 지나야 run 이 끝난다. 스크립트는 기본값을 쓰므로 1분쯤 걸린다.
