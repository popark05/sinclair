# 04: SQLite 영속화와 저장소 ADR

**What to build:** control-plane 를 껐다 켜도 저장된 Run/Attempt 가 남는다. intent 의 열린 질문(SQLite vs PostgreSQL)을 ADR 로 닫고(제안: 사내 단일 서버·설치형 환경에 맞춰 Node 내장 `node:sqlite` 로 시작, 저장소 인터페이스 뒤라 교체 가능), 02 의 저장소 인터페이스를 SQLite 로 구현해 같은 공유 테스트 스위트를 통과시킨다.

**Blocked by:** 02 (저장소 인터페이스와 공유 테스트)

**Status:** done

- [x] ADR: 저장소 선택과 근거, PostgreSQL 로 옮길 때의 조건. intent 열린 질문에 취소선 + 링크
- [x] SQLite 저장소 구현이 02 의 공유 스위트를 그대로 통과(멱등·순서 무관 포함). 스키마 마이그레이션은 버전 번호 1개로 시작
- [x] `eventId` 유일 제약이 DB 수준에서 중복을 막는다(같은 파일을 연 두 핸들이 같은 이벤트를 넣어도 1건; 단일 프로세스 동기 API 라 경쟁이 아니라 제약 검증)
- [x] 서버 재시작 테스트: 저장 → 프로세스(또는 인스턴스) 종료 → 다시 열어 `GET /runs/:id` 가 같다
- [x] 설정으로 인메모리/SQLite 를 고른다(테스트는 인메모리 기본, 실행은 SQLite 기본). DB 파일 위치는 설정값
- [x] `verify-ingest` 스킬이 SQLite 모드로도 돈다

## Comments

- 2026-11-07: 완료. ADR `docs/adr/0004-control-plane-storage.md`: Node 내장 `node:sqlite`(네이티브 의존 없음, 설치형·사내망 제약에 맞음)로 시작, PostgreSQL 전환 조건(다중 인스턴스, 원격 DB, 쓰기 처리량) 명시; intent 열린 질문에 취소선. `apps/control-plane/src/sqlite-store.ts` `createSqliteEventStore(file | ':memory:')`: `events(seq AUTOINCREMENT, event_id UNIQUE, run_id, payload JSON)` + `runs(run_id, first_seen)`, `INSERT OR IGNORE` 로 중복은 DB 제약이 막음, `PRAGMA user_version = 1`(더 새로운 버전은 열지 않음), WAL, 없는 디렉터리 생성. 공유 스위트를 파일·:memory: 두 모드로 통과 + 재시작 영속·스키마 가드·디렉터리 생성·동시 append 20건 중 1건만 accepted + HTTP 재시작(바이트 동일, 재전송 duplicate) 테스트. `verify-ingest` 에 `SINCLAIR_INGEST_STORE=sqlite` 모드와 `features/persistence.md`. 구동 증거 `04-sqlite-latest.json`: 저장 5 → stop/start → 투영 바이트 동일(persisted true) → 재전송 duplicate 5.
- 결정: 테스트는 인메모리 기본, 실행은 SQLite 기본(스킬은 env 로 선택; 서버 실행 엔트리는 runner-agent/배포 티켓에서). 다중 프로세스 쓰기는 범위 밖.
- 2026-11-07 리뷰 반영(Standards + Spec): (1) `engines.node >= 22.13`, ADR 에 `node:sqlite` experimental(Stability 1.1)·ExperimentalWarning·동기 블로킹 근거·`## 이유` 절·제품용 설정은 배포 티켓으로 이연을 명시. (2) `runs` 테이블 제거, run 목록은 `events` 에서 파생(INSERT 하나라 크래시에도 어긋나지 않음, 트랜잭션 불필요). (3) 버전 0 인데 테이블이 있는 파일(다른 앱 DB)은 열지 않음 + 테스트. (4) 유일 제약 테스트를 같은 파일을 연 두 핸들이 번갈아 append 하는 형태로(동기 API 라 "동시" 가 아니라 DB 제약 검증임을 주석에 명시; 체크박스 문구도 그 의미). (5) `schema-check.sh` 로 persist-schema 를 스크립트화, evidence 에 `schemaGuard.refused: true`. (6) 테스트 임시 디렉터리 누수 제거, 이벤트 픽스처를 `test/fixtures.ts` 로 통합. 05 메모: Cycle/Run 등록은 이벤트가 아닌 레코드라 별도 `CycleStore`(메모리/SQLite + 공유 스위트)가 필요하고 첫 마이그레이션 1→2 가 생긴다.
