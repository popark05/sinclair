# SQLite 영속 (서버 재시작)

SQLite 모드에서는 저장된 이벤트가 서버 프로세스보다 오래 남는다. 같은 DB 파일로 다시 띄우면 이전 run 이 조회되고, 재전송은 duplicate 로 흡수된다.

## Sub-features

- `persist-restart` stop → start 뒤 `GET /runs/<id>` 가 재시작 전과 바이트 단위로 같다.
- `persist-dup` 재시작 뒤 같은 배치 재전송이 전부 `duplicate`.
- `persist-schema` 다른 스키마 버전의 DB 파일은 서버가 기동을 거부한다(`server.out` 에 "스키마 버전").

## How to get to it (user POV)

control-plane 를 배포하거나 재시작해도 Console 이 지난 Cycle/Run 을 계속 본다.

## Driving it with scripts

```bash
export SINCLAIR_INGEST_STORE=sqlite
$S/start.sh $RUN && $S/doctor.sh $RUN
$S/ingest.sh $RUN $S/sample-events.json before-restart
$S/get.sh $RUN /runs/verify-run view-before >/dev/null
$S/stop.sh $RUN
$S/start.sh $RUN && $S/doctor.sh $RUN            # 같은 $RUN → 같은 control-plane.db
$S/get.sh $RUN /runs/verify-run view-after >/dev/null
diff <(node -p "JSON.stringify(require('./$RUN/evidence/view-before.json').response)") <(node -p "JSON.stringify(require('./$RUN/evidence/view-after.json').response)") && echo PERSISTED
$S/ingest.sh $RUN $S/sample-events.json after-restart   # {"accepted":0,"duplicate":5,"rejected":[]}
$S/stop.sh $RUN
```

## Gotchas

- 인메모리 모드에서는 재시작하면 비어 있다. `README` 의 Baseline(빈 저장소)은 새 `$RUN` 이거나 memory 모드일 때만 성립한다.
- WAL 모드라 `control-plane.db-wal`/`-shm` 파일이 함께 생긴다. DB 를 옮길 때 셋을 같이 옮긴다.
