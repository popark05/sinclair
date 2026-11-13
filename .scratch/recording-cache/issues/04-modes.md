# 04: 모드 — off·read-only·read-write·strict, 재시도는 재생 안 함

**What to build:** `runTests` 의 cache.mode 와 runner-agent `--cache`(환경변수 `SINCLAIR_AGENT_CACHE`), strict 의 실패 코드(`cache-stale`·`cache-miss`), 재시도 Attempt 는 재생하지 않음.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 모드 표(spec) 그대로, strict 는 쓰기·지우기 없음
- [ ] errorCode `cache-stale`·`cache-miss`(Verdict 는 failed — 테스트가 녹화와 어긋남)
- [ ] runner-agent `run`·`daemon` 옵션, 도움말
- [ ] 테스트: 모드별 재생·기록·지우기 행렬
