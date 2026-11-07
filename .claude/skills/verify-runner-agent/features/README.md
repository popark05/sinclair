# runner-agent verification map

`sinclair-agent run` 의 운영자 관점 동작을 검증하는 유지 소스다. 기능 파일을 읽기 전에 이 인덱스를 먼저 읽는다.

## Baseline preconditions

- `I=.claude/skills/verify-ingest/scripts`, `S=.claude/skills/verify-runner-agent/scripts`, `RUN=.e2e/verify-runner-agent/<timestamp>-<purpose>` 로 리포 루트에서 시작한다.
- `$I/start.sh $RUN` 이 `READY` 를 출력했고 `$I/doctor.sh $RUN` 이 `DOCTOR OK` 다.

## Driving conventions

- 에이전트는 항상 bin(`node apps/runner-agent/bin/sinclair-agent.mjs`)으로 실행한다. 종료 코드를 반드시 기록한다.
- Cycle id 는 매번 새로 만든다(끝난 Cycle 에는 Run 을 등록할 수 없다).

## Proof and skip reporting

- `evidence/agent-run.json` 의 `exitCode` 와 `cycle.state/verdict` 를 인용한다.
- 실기기 증명은 `.scratch/runner-agent/evidence/02-run-once-device-latest.json` 으로만 한다.
- 도달할 수 없는 경로는 시도한 명령과 미충족 선행 조건을 적어 실패로 보고한다.

## Feature entry contract

각 기능 파일은 H1 제목과 한 문단 설명 뒤에 정확히 네 H2 를 이 순서로 가진다: `Sub-features`, `How to get to it (user POV)`, `Driving it with scripts`, `Gotchas`.

## Features

- `run-once.md` — run 하나 실행: 등록, 실행, 보고, 종료 코드.
- `spool-resume.md` — 서버 없이 run → 스풀 → resume.
- `daemon.md` — 데몬 2개가 Run 을 클레임해 Cycle 을 채움, SIGTERM 종료.
