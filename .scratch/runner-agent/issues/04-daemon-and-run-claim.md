# 04: 데몬 모드와 Run 클레임 — 사람 개입 없이 Cycle 매트릭스가 채워진다

**What to build:** QA 담당자가 Cycle 을 만들고(Suite 필터 포함) 타깃별 Run 을 등록해 두면, 기기 노드에서 도는 `sinclair-agent daemon --targets android,ios` 가 control-plane 에서 자기 타깃의 대기 중인 Run 을 클레임해 실행·보고하고, 끝나면 다음 Run 을 가져온다. 같은 Run 을 두 에이전트가 동시에 잡지 않고, 에이전트가 죽으면 lease 가 만료돼 다른 에이전트가 가져간다. Scheduler 의 최소 형태다.

**Blocked by:** 02 (run 실행), 03 (스풀)

**Status:** ready-for-agent

- [ ] control-plane: Cycle 레코드에 Suite 필터(테스트 디렉터리/glob, 선택 태그)가 추가되고 `POST /cycles` 가 받는다(SQLite 마이그레이션 2→3, 공유 스위트 갱신). 도메인 모델의 "Suite 필터" 를 채운다
- [ ] control-plane: `POST /runs/claim { targetId, agentId }` 가 등록됐고 이벤트가 없으며 lease 가 없는(또는 만료된) Run 하나를 lease 와 함께 돌려주고, 없으면 204. lease TTL 과 `POST /runs/:id/heartbeat`. 같은 Run 을 두 번 주지 않는 테스트(직렬 호출 + SQLite 두 핸들)
- [ ] `GET /cycles/:id` 의 run 행에 lease 상태(agentId, 만료)가 보인다
- [ ] 에이전트: `daemon` 이 폴링 간격(이유 주석)으로 클레임 → `run` 경로 재사용 → 보고를 반복하고, run 실패·blocked 뒤에도 계속 돈다. heartbeat 는 run 동안 주기적으로. SIGTERM 에 진행 중 run 의 flush·close 뒤 종료
- [ ] 테스트: 인프로세스 서버 + FakeEngine 으로 Cycle(타깃 2개) 등록 → 데몬 2개(각 타깃) → 둘 다 끝나면 Cycle 이 finished/verified. lease 만료 → 다른 에이전트가 가져가는 테스트
- [ ] `verify-runner-agent` 에 데몬 feature(스크립트로 데몬 띄우고 Cycle 이 채워지는 것을 조회로 증명)
