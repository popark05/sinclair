# 01: 녹화 — act 가 한 액션을 기술자로 기록하고, 검증 뒤 저장소에 커밋

**What to build:** `runAct` 결과에 실행한 액션 기록(툴·대상 기술자·입력 자리표시·방향)과 끝 anchor 를 싣고, 러너가 act 마다 항목을 스테이징했다가 Attempt 끝에 그 뒤 검증 스텝이 통과했으면 `CacheStore` 에 쓴다. 저장소 인터페이스와 메모리·파일 구현, 키 계산.

**Blocked by:** None

**Status:** done

- [x] protocol(또는 runner) `CacheStore { read(key) → entry|undefined; write(key, entry); delete(key) }` + 계약 스위트, 메모리·파일 구현(파일: `<dir>/<key>.json`, 원자적 쓰기, 키 모양 검사)
- [x] 키 계산(spec "키"), callIndex 는 instruction 반복 번호
- [x] agent: 실행 성공한 툴 호출만 기록(대상은 실행 직전 관찰의 기술자), 끝 anchor(act 전후 새로 나타난 이름 있는 노드, 최대 8), 비밀값은 자리표시로
- [x] runner: `runTests({ cache: { store, mode } })`, act 성공 시 스테이징, 검증 스텝(expect 통과·assert 참·waitFor 충족) 뒤면 Attempt 끝에 커밋, 실패·미확인은 버림
- [x] 테스트: FakeEngine 로그인 시나리오로 act → assert 통과면 저장, assert 없음·실패면 저장 안 됨, 비밀값이 항목에 없음

## Comments

- 2026-11-14 구현. protocol `recording-cache.ts`(CacheEntry·CacheTarget·CacheAction, 닫힌 검증기 `parseCacheEntry`, `CACHE_KEY`, `CACHE_LIMITS`, `CacheStore`) + testing 의 `cacheStoreContractSuite`·`createMemoryCacheStore`·`SAMPLE_CACHE_ENTRY`. agent `recording.ts`: 실행에 성공한 툴 호출만(거부·안전망·done 제외) 실행 직전 관찰의 기술자로, type 글자는 모델이 쓴 그대로(비밀값 자리표시, 값 일치 재가림), 기술자가 가림(비밀값·개인정보)에 걸리면 그 act 녹화를 버림. 끝 anchor = 결과 화면에 새로 나타난 이름 있는 노드(두 자리 이상 숫자·가림·secure·중복 제외, 8개). `ActResult.recording`·`startApp`. runner: `runTests({ cache: { store, mode } })`, `cacheKey`(schema·policy·testId·engine·app·정규화 instruction·callIndex 의 sha256), callIndex 는 instruction 반복 번호, 검증 스텝(assert·waitFor 통과 — locator expect 도 kind assert) 뒤면 Attempt 끝 커밋(실패한 Attempt 도 그 전 검증분은 커밋), 쓰기 실패는 경고, `TestResult.cache {saved, unconfirmed}`, act 스텝 `cache: 'live'`(캐시 켜졌을 때만). 파일 저장소 `createFileCacheStore`(원자적 쓰기, 0600, 깨진 파일은 미스).
- 키의 `app` 은 act 시작 화면의 foreground 앱(resource-id 패키지 다수결, `appPackageOf`). 재생(02)은 act 전에 같은 방법으로 앱을 알아 키를 만든다.
