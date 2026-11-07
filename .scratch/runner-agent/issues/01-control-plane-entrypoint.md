# 01: control-plane 서버 엔트리와 설정

**What to build:** 운영자가 `sinclair-control-plane` 하나로 제어 평면을 띄운다. 포트·호스트·저장소 종류(기본 SQLite)·DB 파일 경로를 플래그 또는 환경변수로 주고, 기동 로그에 어느 저장소·어느 파일인지 찍히며, SIGTERM/SIGINT 에 연결을 닫고 DB 를 정상 종료한다. 티켓 control-plane-ingest 04 에서 미룬 "실행은 SQLite 기본" 이 제품 코드가 된다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 실행 파일(워크스페이스 `bin`)이 `--port`, `--host`, `--store memory|sqlite`, `--db <path>` 와 같은 이름의 환경변수를 받고, 기본은 127.0.0.1·sqlite·OS 데이터 디렉터리 아래 파일이다. 상수마다 이유 주석
- [ ] 기동 시 한 줄 로그(주소, 저장소, DB 경로, 스키마 버전)와 종료 시 정상 close. 잘못된 설정(없는 저장소 이름, 열 수 없는 DB)은 0 이 아닌 종료 코드와 한국어 메시지
- [ ] 다른 스키마 버전의 DB 로 기동하면 거부 메시지를 내고 종료한다(ADR 0004)
- [ ] 테스트: 자식 프로세스로 띄워 `/health` 와 `POST /ingest` → 재기동 뒤 `GET /runs/:id` 유지(sqlite), memory 모드에서는 사라짐
- [ ] `verify-ingest` 스킬의 `start.sh` 가 이 엔트리를 쓰도록 전환하고 features 를 갱신한다
