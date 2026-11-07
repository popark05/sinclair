# 04: 데몬 모드와 Run 클레임 — 사람 개입 없이 Cycle 매트릭스가 채워진다

**What to build:** QA 담당자가 Cycle 을 만들고(Suite 필터 포함) 타깃별 Run 을 등록해 두면, 기기 노드에서 도는 `sinclair-agent daemon --targets android,ios` 가 control-plane 에서 자기 타깃의 대기 중인 Run 을 클레임해 실행·보고하고, 끝나면 다음 Run 을 가져온다. 같은 Run 을 두 에이전트가 동시에 잡지 않고, 에이전트가 죽으면 lease 가 만료돼 다른 에이전트가 가져간다. Scheduler 의 최소 형태다.

**Blocked by:** 02 (run 실행), 03 (스풀)

**Status:** done

- [x] control-plane: Cycle 레코드에 Suite 필터(테스트 디렉터리/glob, 선택 태그)가 추가되고 `POST /cycles` 가 받는다(레코드가 JSON 컬럼이라 SQLite 마이그레이션 없음 — 아래 결정). 도메인 모델의 "Suite 필터" 를 채운다
- [x] control-plane: `POST /runs/claim { targetId, agentId }` 가 등록됐고 이벤트가 없으며 lease 가 없는(또는 만료된) Run 하나를 lease 와 함께 돌려주고, 없으면 204. lease TTL 과 `POST /runs/:id/heartbeat`. 같은 Run 을 두 번 주지 않는 테스트(직렬 호출 + SQLite 두 핸들)
- [x] `GET /cycles/:id` 의 run 행에 lease 상태(agentId, 만료)가 보인다
- [x] 에이전트: `daemon` 이 폴링 간격(이유 주석)으로 클레임 → `run` 경로 재사용 → 보고를 반복하고, run 실패·blocked 뒤에도 계속 돈다. heartbeat 는 run 동안 주기적으로. SIGTERM 에 진행 중 run 의 flush·close 뒤 종료
- [x] 테스트: 인프로세스 서버 + FakeEngine 으로 Cycle(타깃 2개) 등록 → 데몬 2개(각 타깃) → 둘 다 끝나면 Cycle 이 finished/verified. lease 만료 → 다른 에이전트가 가져가는 테스트
- [x] `verify-runner-agent` 에 데몬 feature(스크립트로 데몬 띄우고 Cycle 이 채워지는 것을 조회로 증명)

## Comments

- 2026-11-08: 완료. control-plane: `CycleRecord.suite?: { tests, tags? }`, `RunRegistration.lease?: { agentId, expiresAt }`, `CycleStore.claimRun(targetId, agentId, now, ttl, hasEvents)`/`heartbeat(runId, agentId, now, ttl)`(메모리; SQLite 는 레코드 텍스트 비교 `UPDATE … WHERE record = ?` CAS 로 두 핸들 경쟁 차단), `POST /runs/claim`(200 `{run, leaseTtlMs, suite?}` / 204), `POST /runs/:id/heartbeat`(200/409 not-owner/404), lease TTL 기본 60초(옵션 `leaseTtlMs`, 테스트용 `now`), `GET /cycles/:id` run 행에 `lease`·Cycle 에 `suite`. 클레임 공유 스위트(메모리·SQLite + 두 핸들) 9개, HTTP 3개. runner-agent: `daemon.ts` `runDaemon(args, deps)`(시작 시 `resumeSpool`, 타깃 순회 클레임 → suite.tests ?? --tests → heartbeat TTL/3 → `executeRun` → 다음; 없으면 `pollMs`(기본 5초) 대기; `signal` 에 진행 중 run 을 마치고 종료), `sinclair-agent daemon`(`--targets a,b`, `--poll`, 나머지는 run 과 같음; SIGTERM/SIGINT → abort). 테스트 4(데몬 2개가 타깃 2개 Cycle 을 verified 로, suite 디렉터리 사용, 실패 뒤 계속 + 신호 종료, lease 만료 재클레임 + 만료 전 거부). `verify-runner-agent` 에 `daemon.sh` + `features/daemon.md`; 구동 증거 `04-daemon-latest.json`: finished/verified, lease node-a/node-b, 두 데몬 SIGTERM 뒤 exit 0.
- 결정: Suite 와 lease 는 JSON 레코드 안에 들어가 SQLite 스키마 변경(2→3)이 필요 없었다(티켓 예상과 다름). 클레임 대상은 "등록됐고 이벤트가 없고 lease 가 없거나 만료" — 이벤트가 있는 Run 은 에이전트가 죽어도 재클레임하지 않는다(부분 보고 run 의 재실행은 재시도 정책 티켓에서). SIGTERM 은 진행 중 run 을 중단하지 않고 마친다(러너는 테스트 중간 중단을 지원하지 않음).
- 2026-11-08 리뷰 반영(Standards + Spec): (1) spec 0001 에 Run 클레임·lease·heartbeat 의미, "이벤트 있는 Run 은 재클레임 안 함", lease 를 잃어도 run 은 끝까지 돌아 같은 runId 로 보고되는 알려진 한계, 기기 lease 는 아직 없음, Suite 필터(`tags` 는 저장만)를 기록; "Suite 필터는 아직 없다" 문구 삭제. ADR 0004 결과 절에 JSON 레코드 CAS 패턴과 키 순서 보존 근거. (2) 데몬: heartbeat 가 not-owner/no-run 이면 heartbeat 를 멈추고 `leaseLost` 로 표시, run 끝에 경고; `MIN_HEARTBEAT_MS` 1초 하한 설명; RunArgs 에 데몬 전용 필드가 섞이지 않게 분리; `sinclair-agent daemon` 종료 코드는 모든 run 통과면 0, 아니면 1. (3) `parseDaemonArgs` 를 run 과 같은 옵션 표·공용 파서(`parseWithTable`)로, DAEMON_HELP 는 표에서 생성, `--poll` 최소 100ms, `--agent` 도움말에 "한 머신에 여럿이면 다르게" 경고. (4) SQLite heartbeat CAS 루프 3회 상한, 메모리 claim 의 이중 검사 주석 정정. (5) "죽은 에이전트" 테스트를 정직하게: heartbeat 가 네트워크 오류로 닿지 않는 fetch 를 주입해 lease 가 실제로 만료되게 하고, abort 때 엔진 준비를 거부로 풀어 데몬이 blocked 로 끝나는 것까지 기다린다(미해결 promise 누수 제거); 폴링 상한을 `until` 헬퍼로 통일하고 상수 이유 주석. 미반영: heartbeat 간격 정책을 서버가 내려주는 것(지금은 TTL/3 클라이언트 정책)과 `tags` 필터링은 후속; SIGTERM 의 프로세스 수준 "진행 중 run 마치기" 는 bin 테스트로 검증하지 않음(인프로세스 AbortSignal 테스트 + daemon.sh 의 run 완료 뒤 SIGTERM 로그로 대신).
