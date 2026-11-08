---
name: verify-ingest
description: "Sinclair control-plane(apps/control-plane)의 Ingest HTTP 서버를 실제로 띄워 Reporter 경로(POST /ingest, GET /runs)로 구동하고 멱등 저장·투영을 증명한다. Ingest, 이벤트 검증, 저장소, Run/Attempt 투영, Cycle/Verdict 를 바꿨을 때, 또는 '이벤트가 멱등하게 저장되는지 보여 달라'는 요청에 쓴다."
---

# verify-ingest

`apps/control-plane` 의 HTTP 서버를 **인메모리(기본) 또는 SQLite 저장소**로 띄워 Reporter 가 하듯 `POST /ingest` 로 이벤트 배치를 보내고 `GET /runs/:id` 로 투영을 읽어 파일로 남긴다. 영속(서버 재시작 뒤 조회)은 SQLite 모드에서만 증명된다.

모든 명령은 리포 루트에서 실행한다. 포트는 매번 OS 가 배정한다.

```bash
S=.claude/skills/verify-ingest/scripts
RUN=.e2e/verify-ingest/$(date +%Y%m%d-%H%M%S)-<목적>
```

## Launch

```bash
$S/start.sh $RUN
# 출력 마지막 줄: READY http://127.0.0.1:<n> port=<n> store=memory pid=<pid>
SINCLAIR_INGEST_STORE=sqlite $S/start.sh $RUN
# READY http://127.0.0.1:<n> port=<n> store=sqlite db=<RUN>/control-plane.db schema=<v> pid=<pid>
```

- `start.sh` 가 서버 엔트리 `apps/control-plane/bin/sinclair-control-plane.mjs`(루트 `pnpm control-plane` 과 같은 것)를 `--port 0 --store <kind> --db <file>` 로 띄운다. 이 엔트리는 아직 리포 체크아웃 안에서만 돈다(설치형 번들은 패키징 티켓). 준비 완료 기준은 `server.out` 의 `READY` 줄이며 그때 `$RUN/server.json`(port, pid, store, sqlite 면 db) 이 있다. bin 은 `--experimental-transform-types` 로 자신을 다시 띄우므로 `server.pid` 는 셸 프로세스이고, 그 자식이 서버다(stop.sh 의 SIGTERM 이 전달된다).
- **짧은 lease:** `SINCLAIR_INGEST_LEASE_TTL_MS=<ms>` 로 띄우면 `--lease-ttl-ms` 가 전달돼 버려진 Run 정리(`features/abandoned.md`)를 초 단위로 본다.
- **SQLite 모드:** `SINCLAIR_INGEST_STORE=sqlite`. DB 파일은 `$RUN/control-plane.db`(`SINCLAIR_INGEST_DB` 로 변경). 같은 `$RUN` 으로 `stop.sh` → `start.sh` 하면 같은 파일을 다시 열어 이전 run 이 보인다(`features/persistence.md`).
- 시드 데이터 없음. 빈 저장소로 시작하므로 멱등 증명은 한 RUN 안에서 한다.
- 인증 없음(아직 범위 밖). 127.0.0.1 에만 바인딩한다. 설정 오류·스키마 불일치면 종료 코드 2 와 메시지가 `server.out` 에 남고 start.sh 가 실패한다.

## Doctor

```bash
$S/doctor.sh $RUN
```

읽기 전용. pid 생존, 포트 소유자가 그 pid 이거나 그 자식(셸이 재실행한 서버)인지, `/health` 200, 배열 아닌 본문에 400 을 확인하고 `DOCTOR OK` 또는 `DOCTOR FAIL: <이유>` 를 출력한다.

## Drive

```bash
$S/ingest.sh $RUN <events.json | '[...]'> [evidence-name]   # POST /ingest, 응답 {accepted, duplicate, rejected[]}
$S/get.sh $RUN /runs/<runId> [evidence-name]               # RunView
$S/get.sh $RUN /runs [evidence-name]                        # 요약 목록
$S/order-check.sh $RUN <events.json> [evidence-name]        # 정순 run 과 역순·분할 run 의 투영 비교 → ORDER-INDEPENDENT
$S/run-sample.sh $RUN [batchSize]                           # 러너(FakeEngine 샘플) → HTTP Reporter → Ingest. evidence/run-sample.json
$S/cycle.sh $RUN [name]                                     # Cycle → Run 등록 → 이벤트 → 매트릭스·Verdict. evidence/<name>-*.json
SINCLAIR_INGEST_LEASE_TTL_MS=1000 $S/abandoned.sh $RUN [name]  # 버려진 Run → infra-failed + 대체 Run → 클레임·완료 → verified (같은 값으로 start.sh 한 서버)
```

- `evidence-name` 을 주면 요청+상태+응답을 `$RUN/evidence/<name>.json` 에 저장한다.
- 안정적인 핸들: `scripts/sample-events.json`(run `verify-run`, attempt `v-a1`, eventId `v-e0..4`). 이벤트 모양은 `packages/protocol/src/events.ts`, 검증 규칙은 `event-schema.ts`.
- 레시피는 `features/` 에 있다. 먼저 `features/README.md` 를 읽는다.

## Evidence

위치: `$RUN/evidence/*.json`, `$RUN/server.out`.

증명 기준:

- Reporter 가 쓰는 실제 경로(HTTP + JSON 배열)로 보낸다. `ingestBatch()` 를 직접 부르는 것은 단위 테스트지 증명이 아니다.
- 멱등은 **같은 배치를 두 번** 보내 두 번째 응답이 전부 `duplicate` 이고 두 조회 결과가 바이트 단위로 같음을 보인다.
- 순서 무관은 `order-check.sh` 가 `ORDER-INDEPENDENT` 를 출력하고 `evidence/<name>-view-ordered.json` 과 `-view-shuffled.json` 이 runId 만 다름을 보인다.
- 거부는 `rejected[].index/eventId/errors` 로 증명하고, 같은 배치의 올바른 원소가 저장됐음을 조회로 보인다.
- 어느 저장소 모드였는지 보고서에 쓴다. 영속은 SQLite 모드에서 `stop.sh` → `start.sh` 뒤 조회로 증명한다.

## Cleanup

```bash
$S/stop.sh $RUN
```

`$RUN/server.pid` 의 pid 에만 SIGTERM(3초 후 SIGKILL). `evidence/`, `server.out` 은 남긴다. `.e2e/` 는 git-ignore 되어 있다.

## Helpers

| 스크립트 | 역할 |
| --- | --- |
| `scripts/start.sh <RUN>` | 서버 기동, READY 대기, pid 기록 |
| `scripts/doctor.sh <RUN>` | 읽기 전용 상태 점검 |
| `scripts/ingest.sh <RUN> <batch> [name]` | POST /ingest + 증거 저장 |
| `scripts/get.sh <RUN> <path> [name]` | GET + 증거 저장 |
| `scripts/order-check.sh <RUN> <events.json> [name]` | 순서 무관 증명(runId 접미사 `-ordered`/`-shuffled`) |
| `scripts/run-sample.sh <RUN> [batchSize]` | 러너 샘플을 HTTP Reporter 로 흘려보냄 |
| `scripts/cycle.sh <RUN> [name]` | Cycle 생성 → Run 등록 → 이벤트 → `GET /cycles/:id` (passed-flaky, verified) |
| `scripts/schema-check.sh <RUN>` | (sqlite, 서버 내린 뒤) 더 새로운 스키마 버전 파일의 기동 거부 증명 |
| `scripts/stop.sh <RUN>` | 우리가 띄운 pid 만 종료 |
| `scripts/sample-events.json` | 완료된 run 1개의 이벤트 5개 |
