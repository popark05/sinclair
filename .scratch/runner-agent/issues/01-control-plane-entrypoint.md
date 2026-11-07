# 01: control-plane 서버 엔트리와 설정

**What to build:** 운영자가 `sinclair-control-plane` 하나로 제어 평면을 띄운다. 포트·호스트·저장소 종류(기본 SQLite)·DB 파일 경로를 플래그 또는 환경변수로 주고, 기동 로그에 어느 저장소·어느 파일인지 찍히며, SIGTERM/SIGINT 에 연결을 닫고 DB 를 정상 종료한다. 티켓 control-plane-ingest 04 에서 미룬 "실행은 SQLite 기본" 이 제품 코드가 된다.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 실행 파일(워크스페이스 `bin`)이 `--port`, `--host`, `--store memory|sqlite`, `--db <path>` 와 같은 이름의 환경변수를 받고, 기본은 127.0.0.1·sqlite·OS 데이터 디렉터리 아래 파일이다. 상수마다 이유 주석
- [x] 기동 시 한 줄 로그(주소, 저장소, DB 경로, 스키마 버전)와 종료 시 정상 close. 잘못된 설정(없는 저장소 이름, 열 수 없는 DB)은 0 이 아닌 종료 코드와 한국어 메시지
- [x] 다른 스키마 버전의 DB 로 기동하면 거부 메시지를 내고 종료한다(ADR 0004)
- [x] 테스트: 자식 프로세스로 띄워 `/health` 와 `POST /ingest` → 재기동 뒤 `GET /runs/:id` 유지(sqlite), memory 모드에서는 사라짐
- [x] `verify-ingest` 스킬의 `start.sh` 가 이 엔트리를 쓰도록 전환하고 features 를 갱신한다

## Comments

- 2026-11-07: 완료. `apps/control-plane/src/config.ts` `parseConfig(argv, env, platform)`(플래그 > `SINCLAIR_CP_*` > 기본값; 기본 127.0.0.1:4780, sqlite, OS 데이터 디렉터리/sinclair/control-plane.db; `--key=value` 도 허용; 잘못된 값은 `ConfigError`; `--help`), `src/main.ts` `startControlPlane(config)` + `main()`(READY 한 줄 로그: 주소·포트·저장소·DB·스키마 버전·pid, SIGTERM/SIGINT 에 서버·DB close, 종료 코드 0/2), `bin/sinclair-control-plane.mjs`(`--experimental-transform-types` 없으면 자신을 재실행, 신호 전달; package.json `bin`). 테스트: config 표 12개, 자식 프로세스 bin 4개(sqlite 재기동 유지·환경변수 DB, memory 소실, 설정 오류·스키마 99 거부 코드 2, --help). `verify-ingest` `start.sh` 가 bin 으로 전환(`serve.ts` 삭제, doctor 는 셸 자식의 포트 소유 허용). 전 feature(memory·sqlite·order·run-sample·cycle·persistence·schema-guard)를 bin 으로 구동 확인.
- 결정: 기본 포트 4780(흔한 개발 포트와 충돌 회피). bin 은 ExperimentalWarning 을 끈다(`--no-warnings=ExperimentalWarning`).
- 2026-11-07 리뷰 반영(Standards + Spec): (1) 정직한 한계 명시 — bin 은 리포 체크아웃 안에서만 돈다(src/*.ts + 워크스페이스 node_modules + experimental 플래그). 루트 `pnpm control-plane` 스크립트 추가, 설치형 번들은 패키징 티켓(runner-agent 05 또는 별도)로. bin·SKILL.md·ADR 에 기록. (2) argv 파서를 `node:util.parseArgs` 로 바꾸고 옵션 표 하나가 파서·도움말·환경변수 이름을 만든다. (3) 도움말에 "인증 없음, 외부 바인딩은 신뢰망 안에서만" 경고와 READY 줄 계약 명시. (4) 두 번째 신호는 즉시 종료(130), close 완료 로그, 서버 close 가 keep-alive 연결을 끊는다. (5) `index.ts` 는 `startControlPlane` 만 export(`main` 은 bin 전용). (6) 쓸 수 없는 디렉터리의 DB → 코드 2 테스트, 위치 인자 거부 테스트, 대기 상수 주석. (7) SKILL.md 의 READY 예시·doctor 설명 갱신. Windows 신호 한계는 bin 주석에.
