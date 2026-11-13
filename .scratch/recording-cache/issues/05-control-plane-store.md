# 05: control-plane 공유 저장 — 노드 하나가 녹화하면 플릿이 재생

**What to build:** control-plane `GET/PUT/DELETE /cache/:key`(SQLite 스키마 5 `recording_cache`, 메모리), runner-agent 의 HTTP `CacheStore`(실패는 미스로 — 저장소 장애가 테스트를 막지 않음), 데몬·run 기본 저장소를 control-plane 으로.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 키 모양 검사(64자 16진수), 항목 크기 상한(64KiB), 항목 스키마 검사
- [ ] 계약 스위트를 HTTP 저장소에도
- [ ] 저장소 오류: 읽기 실패 = 미스, 쓰기 실패 = 경고 로그(테스트 결과 불변)
- [ ] runner-agent `run`·`daemon` 의 `--cache off|read-only|read-write|strict`(`SINCLAIR_AGENT_CACHE`, 기본 read-write) — 04 에서 옮김
- [ ] verify-runner-agent: 노드 A 가 녹화, 노드 B 가 재생(FakeEngine)
