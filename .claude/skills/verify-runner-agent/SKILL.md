---
name: verify-runner-agent
description: "Sinclair runner-agent(apps/runner-agent)의 `sinclair-agent run` 이 Cycle 의 Run 을 등록·실행·보고해 control-plane 의 Cycle 매트릭스를 채우는지 실제 bin 두 개(control-plane, agent)로 증명한다. 에이전트 CLI, Run 등록, 엔진 선택, Reporter 연결을 바꿨을 때, 또는 '에이전트가 끝까지 도는지 보여 달라'는 요청에 쓴다."
---

# verify-runner-agent

`verify-ingest` 의 `start.sh` 로 control-plane 을 띄운 뒤, 이 스킬의 스크립트가 Cycle 을 만들고 `sinclair-agent run|daemon|resume` 을 실제 bin 으로 실행해 종료 코드·출력·Cycle 뷰를 증거로 남긴다. 실기기 경로는 opt-in 테스트로 증명한다.

모든 명령은 리포 루트에서 실행한다.

```bash
I=.claude/skills/verify-ingest/scripts
S=.claude/skills/verify-runner-agent/scripts
RUN=.e2e/verify-runner-agent/$(date +%Y%m%d-%H%M%S)-<목적>
```

## Launch

```bash
$I/start.sh $RUN        # control-plane (memory, 또는 SINCLAIR_INGEST_STORE=sqlite)
```

준비 완료 기준은 `verify-ingest` 와 같다(`READY` 줄, `$RUN/server.json`). 에이전트는 별도 기동이 없다(명령마다 실행되고 끝난다).

## Doctor

```bash
$I/doctor.sh $RUN
node apps/runner-agent/bin/sinclair-agent.mjs run --help    # 사용법이 찍히고 0 으로 끝나면 bin 이 로드된다
```

## Drive

```bash
$S/run-fake.sh $RUN [cycleId] [tests-dir]
# 마지막 줄: AGENT exit=0 cycle=<id> state=finished verdict=verified
$S/spool-resume.sh $RUN      # RUN exit=0 spool=[…jsonl …meta.json] → RESUME exit=0 spool=[] run.state=finished (약 1분)
$S/daemon.sh $RUN            # DAEMON … state=finished verdict=verified leases=node-a,node-b exits=0,0
$S/fleet.sh $RUN             # Fleet(자체 control-plane, TTL 2초): fake 데몬 2개 → idle → 느린 Run 중 leased → 끝나면 idle → 하나 SIGKILL → offline
$S/retry-e2e.sh $RUN         # 재시도 정책 종단(자체 control-plane, TTL 2초): kill·limit·lease 세 경로 → RETRY-E2E OK checks=10/10 (약 45초)
```

- 기본 테스트 디렉터리는 `apps/runner-agent/test/fixtures/only-login`(통과 1). `apps/runner-agent/test/fixtures`(통과 1 + 실패 1)를 주면 exit=1, verdict=blocked 가 정상이다.
- 실기기: `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/run-once.device.test.ts`. 설정 앱 샘플을 engine mobile 로 돌려 `.scratch/runner-agent/evidence/02-run-once-device-latest.json` 에 남긴다(시리얼 마스킹). 같은 실행이 두 번째 Cycle 을 `retries: 1` 로 돌려(`fixtures/device-flaky`, 첫 시도만 실패) 매트릭스 셀 `passed-flaky` 를 `02-run-once-retry-device-latest.json` 에 남긴다.
- 레시피는 `features/` 에 있다. 먼저 `features/README.md` 를 읽는다.

## Evidence

위치: `$RUN/evidence/agent-run.json`(종료 코드, 에이전트 출력, Cycle 뷰), `$RUN/server.out`.

증명 기준:

- 에이전트가 실제 bin 으로 실행돼 control-plane 의 실제 HTTP 로 등록·전송했다(인프로세스 호출은 단위 테스트지 증명이 아니다).
- `exitCode` 와 Cycle 의 `state/verdict/matrix` 를 함께 인용한다. 종료 코드 계약(`run`): 0 통과, 1 실패 있음, 2 기기 불가, 3 설정·등록 오류. 데몬 안의 run 별 코드에는 5 중단(cancelled: lease 상실·종료 신호)이 더 있고, 데몬 프로세스는 cancelled run 을 실패로 세지 않는다.
- FakeEngine 증명은 Reporter → Ingest → Verdict 경로만 증명한다. 기기 동작은 실기기 evidence 로만 주장한다.

## Cleanup

```bash
$I/stop.sh $RUN
```

## Helpers

| 스크립트 | 역할 |
| --- | --- |
| `scripts/run-fake.sh <RUN> [cycleId] [tests-dir]` | Cycle 생성 → `sinclair-agent run --engine fake` → 증거 |
| `scripts/spool-resume.sh <RUN>` | 서버 내린 채 run → 스풀 → 같은 포트 재기동 → `resume` → 증거 |
| `scripts/daemon.sh <RUN>` | Cycle(타깃 2) + 데몬 2개(bin) → finished/verified → SIGTERM 종료 → 증거 |
| `scripts/retry-e2e.sh <RUN> [ttl]` | 재시도 정책 세 경로(강제 종료·한도 초과·lease 상실) → `04-e2e-latest.json` |
| `scripts/fleet.sh <RUN> [ttl]` | Fleet 인벤토리: 노드 2개 보고 → idle, 하나 죽이면 offline |
| `scripts/hb-proxy.mjs` | heartbeat 만 끊는 프록시(retry-e2e 가 씀) |
| `verify-ingest/scripts/{start,doctor,stop}.sh` | control-plane 수명 |
