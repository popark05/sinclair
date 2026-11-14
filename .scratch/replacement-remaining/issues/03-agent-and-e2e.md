# 03: 에이전트가 skipTests 를 러너에 넘기고, 종단 증명

**What to build:** 데몬이 클레임의 `skipTests` 를 러너(직접·워커 모드)에 넘기고 로그에 건너뛴 수. `verify-runner-agent/scripts/retry-e2e` 에 경로 추가: 앞 케이스를 끝낸 뒤 에이전트를 죽이면 대체 Run 은 남은 케이스만 돌고 Cycle 이 verified.

**Blocked by:** 01, 02

**Status:** done

## 결과 (2026-11-14)

- 데몬: 클레임의 `skipTests` → `RunArgs.skipTests`(데몬 전용, 워커에도 그대로) → `runTests`. 로그 "앞 Run 에서 확정 케이스 N개 건너뜀". 단위: daemon.test 의 취소 뒤 대체 Run(첫째 확정 → 둘째·셋째만 돎, verified).
- retry-e2e remaining 경로: A 가 2개를 끝낸 뒤 SIGKILL → 대체 Run 은 그 둘을 다시 돌지 않음 → 매트릭스 전부 채움, 재시도 테스트는 A 의 passed-flaky 그대로, verified. memory·SQLite 17/17(증거 `.scratch/retry-policy/evidence/04-e2e-latest.json`, `.scratch/replacement-remaining/evidence/03-e2e-latest.json`).
