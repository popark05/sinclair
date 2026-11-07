# 04: SQLite 영속화와 저장소 ADR

**What to build:** control-plane 를 껐다 켜도 저장된 Run/Attempt 가 남는다. intent 의 열린 질문(SQLite vs PostgreSQL)을 ADR 로 닫고(제안: 사내 단일 서버·설치형 환경에 맞춰 Node 내장 `node:sqlite` 로 시작, 저장소 인터페이스 뒤라 교체 가능), 02 의 저장소 인터페이스를 SQLite 로 구현해 같은 공유 테스트 스위트를 통과시킨다.

**Blocked by:** 02 (저장소 인터페이스와 공유 테스트)

**Status:** ready-for-agent

- [ ] ADR: 저장소 선택과 근거, PostgreSQL 로 옮길 때의 조건. intent 열린 질문에 취소선 + 링크
- [ ] SQLite 저장소 구현이 02 의 공유 스위트를 그대로 통과(멱등·순서 무관 포함). 스키마 마이그레이션은 버전 번호 1개로 시작
- [ ] `eventId` 유일 제약이 DB 수준에서 중복을 막는다(동시 배치 2개를 같은 이벤트로 보내도 1건)
- [ ] 서버 재시작 테스트: 저장 → 프로세스(또는 인스턴스) 종료 → 다시 열어 `GET /runs/:id` 가 같다
- [ ] 설정으로 인메모리/SQLite 를 고른다(테스트는 인메모리 기본, 실행은 SQLite 기본). DB 파일 위치는 설정값
- [ ] `verify-ingest` 스킬이 SQLite 모드로도 돈다
