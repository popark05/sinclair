# 04: 모드 — off·read-only·read-write·strict, 재시도는 재생 안 함

**What to build:** `runTests` 의 cache.mode 와 runner-agent `--cache`(환경변수 `SINCLAIR_AGENT_CACHE`), strict 의 실패 코드(`cache-stale`·`cache-miss`), 재시도 Attempt 는 재생하지 않음.

**Blocked by:** 03

**Status:** done

- [x] 모드 표(spec) 그대로, strict 는 쓰기·지우기 없음
- [x] errorCode `cache-stale`·`cache-miss`(Verdict 는 failed — 테스트가 녹화와 어긋남)
- [ ] runner-agent `run`·`daemon` 옵션, 도움말 → 05 로 옮김(저장소와 함께 연결)
- [x] 테스트: 모드별 재생·기록·지우기 행렬

## Comments

- 2026-11-14 구현(runner). read-only = 재생만(기록·지우기 없음 — settleCache 가 read-write 에서만). strict = 모든 시도에서 재생, 녹화 없으면 `CacheReplayError('cache-miss')`, missed·diverged 면 `cache-stale`(이어받지 않음), 쓰기·지우기 없음, 이 두 errorCode 는 재시도하지 않음(결정적 판정). read-write 재시도 Attempt 는 재생하지 않음(02 에서). runner-agent `--cache` 는 저장소가 생기는 05 에서 함께.
