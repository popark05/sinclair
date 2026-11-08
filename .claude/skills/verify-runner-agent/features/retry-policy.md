# 재시도 정책 종단: 죽은·끊긴 데몬의 run 이 대체되고 재시도까지 거쳐 Cycle 이 판정된다

실제 bin(control-plane 1, 데몬 여러 개)으로 retry-policy 01~03 이 함께 도는지 보인다. 데몬이 run 도중 죽거나 heartbeat 가 끊기면 control-plane 이 그 run 을 버려진 Run 으로 닫고 대체 Run 을 등록하며, 다른 데몬이 대체 Run 을 테스트 재시도(`suite.retries`) 포함으로 끝내 Cycle 이 `verified` 가 된다. 재시도 한도를 넘기면 `blocked` 로 끝난다.

## Sub-features

- `retry-kill` 데몬 A 를 run 도중 SIGKILL → lease 만료 + 유예 뒤 원래 Run `infra-failed` + `replacedBy`, 대체 Run(`retry:<runId>`, `replaces`)을 데몬 B 가 끝냄 → `verified`, `retriesUsed` 1, 첫 시도만 실패하는 테스트가 `passed-flaky`.
- `retry-limit` `retryLimit: 0` 인 Cycle 에서 같은 시나리오 → 대체 Run 없이 `infra-failed` 하나, Cycle `finished`/`blocked`.
- `retry-lease` 데몬 A 는 살아 있고 heartbeat 만 프록시가 끊음 → 대체 Run 을 B 가 클레임한 뒤 차단 해제 → A 의 heartbeat 가 409(`replaced`)를 받아(로그 `heartbeat <run>: replaced`) 진행 중 테스트까지 마치고 나머지를 skipped 로 보고, run 코드 5, 로그 "lease 를 잃어 중단", 데몬 프로세스는 exit 0 → Verdict 는 B 의 run 으로 `verified`.

## How to get to it (user POV)

기기 노드의 데몬이 죽거나(전원·크래시) 네트워크가 끊겨도 QA 담당자는 아무것도 하지 않는다. Cycle 뷰에서 버려진 Run 과 그 대체 Run 의 사슬, 남은 재시도 한도, 재시도로 통과한 셀(`passed-flaky`)을 본다.

## Driving it with scripts

```bash
$S/retry-e2e.sh $RUN            # control-plane 기동(TTL 2초) → 세 경로 → 정리. 약 45초
# OK   kill: …  (10줄)
# RETRY-E2E OK checks=10/10
# 증거: $RUN/evidence/retry-e2e.json → .scratch/retry-policy/evidence/04-e2e-latest.json 로 복사(리포에 남음)
$S/retry-e2e.sh $RUN 3000       # TTL 을 바꿔 돌린다(긴 테스트 길이·개수가 TTL 에 맞춰 늘어난다)
```

`$RUN/retry-<경로>-<a|b>.out` 이 데몬 로그, `$RUN/hb-proxy.out` 이 차단된 heartbeat 기록이다.

## Gotchas

- 이 스크립트는 control-plane 을 스스로 띄우고 내린다(`verify-ingest/start.sh` 를 `SINCLAIR_INGEST_LEASE_TTL_MS` 로). 이미 띄운 서버에 붙지 않는다.
- 경로마다 타깃 id 가 다르다(`e2e-kill`, `e2e-limit`, `e2e-lease`): 데몬이 다른 경로의 Run 을 클레임하지 않게 하려는 것이다.
- lease 경로에서 원래 Run 의 저장된 상태는 `cancelled` 가 아니라 `infra-failed` 다. control-plane 이 먼저 합성 종료(`abandoned:<runId>`)로 닫았고 A 의 `cancelled` 보고는 그 뒤에 도착한다. A 가 중단했다는 증거는 A 의 run 코드 5(`데몬 요약 … e2e-lease:5`)와 로그다.
- 긴 테스트는 `SINCLAIR_E2E_SLOW_MS`/`SINCLAIR_E2E_SLOW_COUNT` 환경변수로 길이를 정한다(스크립트가 TTL 로 계산해 데몬에 넘긴다). 데몬 SIGKILL 은 셸 bin 을 죽이고, 실제 에이전트는 IPC 끊김으로 곧바로 끝난다.
- 기본은 memory 저장소다. SQLite 경로는 `SINCLAIR_INGEST_STORE=sqlite $S/retry-e2e.sh $RUN` 로 같은 스크립트를 돌린다(저장소 계약은 `cycle-store-suite.ts` 가 두 구현 모두에 대해 확인한다).
- 실패하면 증거는 `$RUN/evidence/retry-e2e.json` 에만 남고 리포의 `04-e2e-latest.json` 은 바뀌지 않는다. 중간에 끊겨도 control-plane 은 trap 으로 내려간다.
- FakeEngine 증명이다. 기기 동작은 실기기 evidence(`02-run-once-retry-device-latest.json`)로만 주장한다.
