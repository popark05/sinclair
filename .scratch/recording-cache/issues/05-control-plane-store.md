# 05: control-plane 공유 저장 — 노드 하나가 녹화하면 플릿이 재생

**What to build:** control-plane `GET/PUT/DELETE /cache/:key`(SQLite 스키마 5 `recording_cache`, 메모리), runner-agent 의 HTTP `CacheStore`(실패는 미스로 — 저장소 장애가 테스트를 막지 않음), 데몬·run 기본 저장소를 control-plane 으로.

**Blocked by:** 01

**Status:** done

- [x] 키 모양 검사(64자 16진수), 항목 크기 상한(64KiB), 항목 스키마 검사
- [x] 계약 스위트를 HTTP 저장소에도
- [x] 저장소 오류: 읽기 실패 = 미스, 쓰기 실패 = 경고 로그(테스트 결과 불변)
- [x] runner-agent `run`·`daemon` 의 `--cache off|read-only|read-write|strict`(`SINCLAIR_AGENT_CACHE`, 기본 read-write) — 04 에서 옮김
- [x] 노드 A 가 녹화, 노드 B 가 재생(FakeEngine) — vitest `apps/runner-agent/test/recording-cache.test.ts`(인프로세스 control-plane + runOnce 두 번). 실제 bin 종단은 07 실기기 증명에서

## Comments

- 2026-11-14 구현. protocol `createMemoryCacheStore` 를 제품 모듈로 옮김(testing 은 다시 내보냄 — vitest 를 끌지 않게). control-plane: SQLite 스키마 5 `recording_cache(key, entry, updated_at)` + `createSqliteCacheStore`(계약을 못 통과하는 옛 항목은 미스), `GET/PUT/DELETE /cache/:key`(키 400, 항목 400 + 검증 오류, 없으면 404, DELETE 는 늘 204), sqlite 모드 기본 저장. runner-agent: `createHttpCacheStore`(404 = 미스, 5xx·연결 실패는 던짐 → 러너가 미스·경고), `--cache off|read-only|read-write|strict`(`SINCLAIR_AGENT_CACHE`, 기본 read-write) — run·daemon(워커에도 args 로 전달), run-once 가 control-plane 저장소로 runTests 에 연결.
