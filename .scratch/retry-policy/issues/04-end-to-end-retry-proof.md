# 04: 종단 증명 — 죽은 데몬의 run 이 대체되고 재시도까지 거쳐 Cycle 이 verified 된다

**What to build:** `verify-runner-agent` 에 재시도 정책 전체를 한 번에 보이는 feature 를 더한다: 데몬을 run 도중 강제 종료 → lease 만료·유예 → control-plane 이 버려진 Run 을 infra-failed 처리하고 대체 Run 을 등록 → 다른 데몬이 클레임해 테스트 재시도(`retries`) 포함으로 끝내 Cycle 이 `verified` 가 되고 매트릭스에 `passed-flaky` 셀과 대체 사슬이 보인다. 한도를 넘기면 `blocked` 로 끝나는 경로도 같은 스크립트로.

**Blocked by:** 01 (테스트 재시도), 02 (취소 신호), 03 (버려진 Run·대체)

**Status:** ready-for-agent

- [ ] 스크립트: 짧은 lease TTL 로 control-plane 기동 → Cycle(`retryLimit` 1, `suite.retries` 1) → 데몬 A 를 느린 FakeEngine 픽스처(첫 시도 실패·두 번째 통과하는 테스트 + 긴 테스트)로 띄우고 run 도중 SIGKILL → 유예 뒤 `GET /cycles/:id` 에 `infra-failed`+`replaces` → 데몬 B 가 대체 Run 을 끝냄 → `verified`, `passed-flaky`
- [ ] 한도 초과 경로: `retryLimit` 0 인 Cycle 에서 같은 시나리오 → `blocked`, 대체 Run 없음
- [ ] lease 상실 경로: 데몬 A 를 죽이지 않고 heartbeat 만 끊어(네트워크 차단 흉내) B 가 가져가게 → A 는 `cancelled` 로 끝나고 B 의 run 이 Verdict 에 쓰인다
- [ ] 증거 `.scratch/retry-policy/evidence/04-e2e-latest.json` 에 세 경로의 상태·Verdict·대체 사슬
- [ ] 실기기 1회: 재시도 샘플로 `passed-flaky` 가 실기기에서도 나오는 증거(01 의 샘플 재사용)
