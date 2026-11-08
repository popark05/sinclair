# 버려진 Run 정리와 대체 Run

에이전트가 run 도중 죽어 이벤트는 있는데 `run.finished` 가 없고 lease 가 만료된 Run 은, 유예(lease TTL 과 같은 값)가 더 지나면 클레임·조회 시점에 합성 `run.finished infra-failed`(eventId `abandoned:<runId>`) 로 닫히고, Cycle 의 `retryLimit` 안이면 같은 타깃의 대체 Run 이 등록돼 다음 클레임이 가져간다. Verdict 는 대체된 Run 을 빼고 대체 Run 을 본다.

## Sub-features

- `abandoned-grace` lease 만료 + 유예 전에는 아무 변화 없음(`view-before`).
- `abandoned-synthetic` 유예 뒤 조회에서 원래 Run 이 `infra-failed`, `replacedBy`/`abandonedAt` 이 붙고 `/runs/<id>` 투영도 `infra-failed`.
- `abandoned-replacement` 대체 Run 행(`replaces`), `retriesUsed.android = 1`, 다음 클레임이 대체 Run 을 준다.
- `abandoned-idempotent` 같은 Cycle 을 다시 조회해도 run 이 2개 그대로(합성 이벤트·대체 Run 하나).
- `abandoned-verified` 대체 Run 이 통과로 끝나면 Cycle `finished`/`verified`.
- `retry-limit` `retryLimit: 0` 이면 대체 없이 `infra-failed` 로 남아 `blocked`(단위 테스트 `cycles-http.test.ts`; 스크립트는 한도 1 만 돈다).

## How to get to it (user POV)

runner-agent 가 Run 을 클레임해 돌리다 노드가 죽는다. heartbeat 가 끊겨 lease 가 만료되고, 다른 에이전트의 다음 클레임이나 Console 의 Cycle 조회 때 control-plane 이 정리한다. QA 담당자는 `GET /cycles/:id` 에서 어떤 Run 이 무엇으로 대체됐는지와 남은 한도를 본다.

## Driving it with scripts

```bash
export SINCLAIR_INGEST_LEASE_TTL_MS=1000      # 서버와 스크립트가 같은 값을 봐야 한다
$S/start.sh $RUN                              # READY … (--lease-ttl-ms 1000 으로 기동)
$S/abandoned.sh $RUN abandoned
# → ABANDONED OK {"cycleId":"verify-abandoned-…","verdict":"verified","retriesUsed":{"android":1},"runs":[{"runId":"…","state":"infra-failed","replacedBy":"…"},{"runId":"…","state":"finished","replaces":"…"}]}
# 증거: evidence/abandoned-create.json(retryLimit 1), -claim1.json, -ingest-partial.json, -view-before.json(run 1개),
#       -view-abandoned.json(infra-failed + 대체 Run), -view-abandoned-again.json(그대로 2개), -run1-view.json(state infra-failed),
#       -claim2.json(대체 Run), -ingest-replacement.json, -view-final.json(finished/verified)
```

## Gotchas

- 유예는 lease TTL 과 같으므로 스크립트는 `2 × TTL + 0.3초` 를 기다린다. 기본 TTL(60초)로 띄우면 2분이 걸린다.
- 시계는 서버 `now` 주입이 아니라 실제 시계다. 유예 직전 경계는 단위 테스트(`sweep.test.ts`)가 다룬다.
- lease 없이 시작한 Run(`run --run` 으로 등록만 하고 돌린 경우)은 마지막 이벤트 시각 기준으로 같은 규칙이 적용된다. 오래전 `at` 을 가진 이벤트를 넣으면 바로 정리되니 증명용 이벤트의 `at` 은 지금 시각으로 만든다.
