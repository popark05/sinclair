# 04: run 마다 워커 프로세스 + 다기기 데몬 — 한 노드가 꽂힌 기기 수만큼 동시에 돈다

**What to build:** 데몬이 run 을 같은 프로세스가 아니라 run 하나당 자식 워커 프로세스로 실행한다(러너의 테스트 등록이 프로세스 전역이라 한 프로세스에서는 run 이 직렬로만 돈다). 그 위에서 데몬은 lease 받은 기기마다 run 을 동시에 돌린다. 운영자는 노드당 데몬 하나만 띄우면 기기 3대가 각자 다른 Run 을 동시에 처리하는 것을 본다.

**Blocked by:** 02 (클레임 때 기기 lease)

**Status:** ready-for-agent

- [x] 워커: 데몬이 run 별 자식 프로세스를 띄워 결과(종료 코드·요약)를 받는다. 데몬 종료 신호·lease 상실 취소는 자식에게 전달되어 지금과 같은 의미(현재 테스트까지 마치고 cancelled). 자식이 죽으면 그 run 은 지금의 "에이전트가 죽음" 규칙(버려진 Run)으로 처리된다
- [x] 스풀: 워커가 쓰고 데몬이 재시작 때 이어 보낸다. 동시 run 들이 서로의 스풀을 건드리지 않는다(기존 pid lock 규칙 확인)
- [x] 동시성: 기기마다 한 번에 run 하나. 상한 옵션(기본 = 기기 수). heartbeat 는 run 별
- [x] 설치본(번들)에서도 워커가 뜬다: 자식 실행 경로가 리포 체크아웃·설치 배치 둘 다에서 동작(verify-install 로 확인)
- [x] 테스트: 가짜 기기 3대 노드 → Run 3개가 겹쳐서 돈다(시작·끝 시각이 겹침), 하나를 SIGKILL 해도 나머지는 끝남, 데몬 SIGTERM → 세 run 모두 현재 테스트까지 마치고 cancelled

## Comments

- 2026-11-08 구현(Opus 5.5, 커밋 두 개). 승인된 seam: (1) 워커 `__worker`(IPC start/cancel → log/done), executeRun 그대로·스풀 직접, (2) USB 는 데몬만 — 디바이스 레이어 127.0.0.1 HTTP JSON-RPC(토큰)를 워커에, 기기 준비·정리는 데몬(`AndroidNode.prepare/cleanup/serveRpc`, engineFor 는 그 조합), (3) 기기마다 하나 `--concurrency`, 빈 기기만 클레임, 종료 신호는 모든 워커에, (4) 증명.
- **승인된 seam 과 다르게 한 것**: "데몬이 사라지면 워커는 현재 테스트까지 마치고 끝난다" → 곧바로 끝냄(exit 143). 현재 테스트를 마치고 cancelled 로 보고하면 그 Run 은 끝난 것이 되어 재시도 정책의 버려진 Run → 대체 Run 경로를 타지 못한다(취소된 Run 은 자동 대체되지 않음). 데몬 시절(프로세스 트리 전체가 죽음)과 같은 결과를 지켰다. 계획된 종료(SIGTERM)는 데몬이 cancel 을 보내므로 "현재 테스트까지" 의미가 그대로다. 테스트 추가.
- 발견: 리포 체크아웃의 bin 재실행 셸을 거쳐 워커를 띄우면 IPC 가 손자 프로세스에 전달되지 않아 워커가 start 를 영영 못 받는다(테스트가 처음에 그렇게 띄워 매달렸고, 남은 워커 프로세스를 정리했다). 데몬은 자기 execArgv(변환 플래그 포함)로 워커를 띄워 셸을 거치지 않고, 워커는 30초 안에 start 를 못 받으면 끝나게 했다.
- 테스트: `daemon-workers.test.ts`(실제 bin 워커, 가짜 기기 3대) — Run 3개가 다른 기기·다른 프로세스에서 동시에(시작 최댓값 < 끝 최솟값), 워커 하나 SIGKILL → 나머지 둘 끝남·죽은 run 은 코드 4 와 running 으로 남음, 데몬 종료 신호 → 셋 모두 cancelled, IPC 끊김 → 워커 exit 143·run.finished 없음. 기존 in-process 경로(라이브러리 runDaemon)는 그대로 통과.
- 증명: `fleet.sh`·`retry-e2e.sh`(데몬이 워커 모드, SIGKILL 경로 포함) 재통과, 끝난 뒤 워커·데몬·서버 프로세스 0. 설치본: verify-install `daemon-fake.sh` → `DAEMON exit=0 finished/verified workerLines=1 workersLeft=0`(번들 모드에서도 워커가 뜬다). 실기기(SM-N981N …XLZW): 데몬이 기기를 준비하고 별도 워커 프로세스가 데몬의 RPC 로 Run verified, run.started 기기 = lease 기기, 결과 줄이 워커에서 옴(`.scratch/device-fleet/evidence/04-worker-device-latest.json`). 기기가 한 대라 실기기 동시성은 증명하지 않았다(06 종단에서 여러 기기).
