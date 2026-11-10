# 05: 취소된 Run 자동 재등록 — 계획된 종료가 Cycle 을 blocked 로 끝내지 않게

**What to build:** 노드 종료 신호(SIGTERM/Ctrl-C)나 lease 상실로 `cancelled` 로 끝난 Run 을 control-plane 이 같은 타깃의 대체 Run(`retry:<runId>`)으로 다시 등록한다. 지금은 돌지 못한 케이스가 blocked 로 남고 Cycle 이 blocked 로 끝난다.

**Blocked by:** None

**Status:** done

## 수용 기준

- [x] lease 로 클레임된 Run 이 `run.finished cancelled` 로 끝나면 정리(sweep)가 대체 Run 을 등록하고 원래 Run 에 `replacedBy` 를 단다(유예 없이 — 이미 끝난 Run 이다). 합성 이벤트는 만들지 않는다.
- [x] 대체 Run 은 `replaceReason: 'cancelled'` 를 갖고 Cycle 의 `retryLimit` 을 소모하지 않는다(`retriesUsed` 에도 세지 않는다). 무한 반복을 막는 상한은 타깃당 취소 대체 `MAX_CANCEL_REPLACEMENTS`(5).
- [x] 원래 Run 에는 `abandonedAt` 을 남기지 않는다(버려진 것이 아니다). 멱등: 반복 정리·두 서버 동시 정리에도 대체 Run 하나.
- [x] lease 없이 보고된 Run(`run --run`)의 cancelled 는 건드리지 않는다.
- [x] Console Run 표가 "취소돼 다시 등록" 을 버려짐과 구분해 보여 준다.

## Comments

- 2026-11-10 구현(사용자 결정: retryLimit 을 쓰지 않고 상한만). control-plane `sweepAbandoned` 이 lease 로 클레임돼 `cancelled` 로 끝난 Run 을 유예 없이 대체(`retry:<runId>`, `replaceReason: 'cancelled'`), 타깃당 `MAX_CANCEL_REPLACEMENTS`(5). 버려진 Run 대체와 같은 등록→표시 순서·결정적 id 로 멱등. `markReplaced` 의 `abandonedAt` 을 선택으로(취소 대체엔 없음). `retriesUsed` 는 취소 대체를 세지 않음. Console Run 표 "…가 취소돼 다시 등록" + 안내 문구.
- 동작 변화: 종료 신호로 멈춘 노드의 Cycle 은 이제 `finished/blocked` 가 아니라 대체 Run 이 끝날 때까지 `running/incomplete` 다. runner-agent 데몬 테스트 5개의 기대를 이에 맞춤.
- 증명: `verify-runner-agent/scripts/retry-e2e.sh` 에 cancel 경로(3 판정) 추가 → memory·SQLite 모두 13/13 (`.scratch/followups/evidence/05-cancel-requeue-sqlite-latest.json`, memory 는 `.scratch/retry-policy/evidence/04-e2e-latest.json` 갱신).
- 남긴 것: 대체 Run 은 스위트 전체를 다시 돈다(취소된 Run 에서 이미 통과한 케이스도). 돌지 못한 케이스만 돌리려면 대체 Run 에 테스트 필터를 실어야 한다 — 필요해지면 새 티켓.
