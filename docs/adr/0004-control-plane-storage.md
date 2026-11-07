# 0004. control-plane 저장소는 SQLite(node:sqlite)로 시작한다

- 상태: 승인
- 날짜: 2026-11-07
- intent: intent/0001-sinclair-e2e-platform.md 열린 질문 "SQLite 로 시작할지 PostgreSQL 로 시작할지"

## 맥락
control-plane 은 Ingest 로 들어온 RunEvent 를 eventId 로 멱등 저장하고, Run/Attempt/Cycle 투영은 조회 시 이벤트에서 계산한다(`apps/control-plane/src/projection.ts`). 사내 QA 용이라 제어 평면은 한 대의 서버(또는 QA 담당자의 노트북)에서 하나의 프로세스로 돌고, 쓰기는 runner-agent 몇 대의 배치 전송, 읽기는 Console 조회다. 설치형(macOS/Windows) 환경과 사내망 SSL 인터셉션에서 빌드·설치가 돼야 한다(intent 제약).

후보:
1. **SQLite, Node 내장 `node:sqlite`**: 네이티브 의존 없음(설치·사내망 다운로드 문제 없음), 동기 API, 파일 하나. 단일 프로세스 쓰기에 적합. Node 22.13+ 에서 플래그 없이 쓸 수 있으나 Node 22/24 모두 **Stability 1.1(experimental)** 이라 API 가 바뀔 수 있고 기동 시 `ExperimentalWarning` 이 한 번 찍힌다.
2. **SQLite, better-sqlite3**: 성숙하지만 네이티브 모듈이라 타깃별 바이너리 확보와 Electron 재빌드가 필요하다(EverMock 의 node-usb 와 같은 부담).
3. **PostgreSQL**: 다중 인스턴스·원격 DB 에 맞지만 로컬 개발·설치형 환경마다 DB 서버가 필요하다.

## 결정
`node:sqlite` 의 SQLite 로 시작한다. 저장소는 `EventStore` 인터페이스 뒤에 있고(`apps/control-plane/src/store.ts`) 모든 구현이 같은 공유 스위트(`test/event-store-suite.ts`)를 통과해야 하므로 교체 비용은 구현 파일 하나다. 스키마 버전은 `PRAGMA user_version` 으로 관리하고(현재 1), 더 새로운 버전의 파일이나 다른 앱의 DB 파일은 열지 않는다. 저널은 WAL(조회와 ingest 가 서로 막지 않음).

테스트는 인메모리 저장소가 기본, 실행(`verify-ingest` 의 `SINCLAIR_INGEST_STORE=sqlite`, 이후 runner-agent/서버 배포)은 SQLite 가 기본이다. 제품용 서버 엔트리(저장소·DB 경로 설정)는 아직 없고 배포 티켓에서 만든다. 지금은 `serveControlPlane(store)` 에 저장소를 주입한다.

## 이유
- 설치형·사내망 제약에서 네이티브 모듈 확보가 가장 큰 위험이라 내장 모듈이 유리하다. experimental 표시는 `EventStore` 뒤에 가둬 교체 가능하게 하는 것으로 감수한다.
- 쓰기는 runner-agent 몇 대의 배치, 읽기는 Console 조회라 단일 파일 직렬화로 충분하다.
- 동기 API 가 호출마다 이벤트 루프를 잠깐 막지만, Ingest 본문 상한(8 MB)과 배치 단위(수백 건)가 상한이라 수 ms 다.

## PostgreSQL 로 옮기는 조건
다음 중 하나가 생기면 `EventStore` 의 PostgreSQL 구현을 추가하고 공유 스위트로 검증한다.
- control-plane 인스턴스를 둘 이상 띄워야 한다(고가용성 또는 쓰기 분산).
- DB 가 제어 평면 프로세스와 다른 호스트에 있어야 한다(관리형 DB, 백업 정책).
- 단일 파일의 쓰기 직렬화가 ingest 처리량을 막는다(배치 전송이라 당분간 아님).

## 결과
- `package.json` `engines.node >= 22.13`.
- `createSqliteEventStore(file)` 추가, `SQLITE_SCHEMA_VERSION = 1`(테이블은 `events` 하나, run 목록은 파생). 마이그레이션은 버전 단계별로 `migrate()` 에 더한다. 티켓 05 가 Cycle/Run 등록 레코드를 저장하면 첫 마이그레이션(1→2)이 생긴다.
- WAL 때문에 `*.db-wal`/`*.db-shm` 파일이 함께 생긴다. 백업·이동 시 함께 다룬다.
- 다중 프로세스 쓰기는 지원 범위 밖(동시성 보장은 단일 프로세스 안의 `INSERT OR IGNORE` + UNIQUE 제약).
