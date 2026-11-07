# ingest verification map

`apps/control-plane` Ingest 의 Reporter 관점 동작을 검증하는 유지 소스다. 기능 파일을 읽기 전에 이 인덱스를 먼저 읽는다.

## Baseline preconditions

- `S=.claude/skills/verify-ingest/scripts`, `RUN=.e2e/verify-ingest/<timestamp>-<purpose>` 로 리포 루트에서 시작한다.
- `$S/start.sh $RUN` 이 `READY` 를 출력했고 `$S/doctor.sh $RUN` 이 `DOCTOR OK` 다.
- 저장소는 비어 있다(`GET /runs` → `[]`).

## Driving conventions

- 전송은 `$S/ingest.sh`, 조회는 `$S/get.sh` 로만 한다. eventId·runId 는 문자 그대로 비교한다.
- 한 기능 파일은 Baseline 에서 시작한다.

## Proof and skip reporting

- 증거는 `$RUN/evidence/<name>.json` 을 인용한다. 멱등·순서 무관은 두 조회 결과를 `diff` 한 결과(빈 출력)를 함께 적는다.
- 도달할 수 없는 경로는 시도한 명령과 미충족 선행 조건을 적어 실패로 보고한다.
- 인메모리 저장소 위의 증명임을 항상 명시한다.

## Feature entry contract

각 기능 파일은 H1 제목과 한 문단 설명 뒤에 정확히 네 H2 를 이 순서로 가진다: `Sub-features`, `How to get to it (user POV)`, `Driving it with scripts`, `Gotchas`.

## Features

- `ingest-batch.md` — 배치 저장, 멱등(중복 전송), 순서 무관, 부분 거부, Run 조회.
- `runner-stream.md` — 러너 → HTTP Reporter → Ingest 흘려보내기.
