# 01: 녹화 — act 가 한 액션을 기술자로 기록하고, 검증 뒤 저장소에 커밋

**What to build:** `runAct` 결과에 실행한 액션 기록(툴·대상 기술자·입력 자리표시·방향)과 끝 anchor 를 싣고, 러너가 act 마다 항목을 스테이징했다가 Attempt 끝에 그 뒤 검증 스텝이 통과했으면 `CacheStore` 에 쓴다. 저장소 인터페이스와 메모리·파일 구현, 키 계산.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] protocol(또는 runner) `CacheStore { read(key) → entry|undefined; write(key, entry); delete(key) }` + 계약 스위트, 메모리·파일 구현(파일: `<dir>/<key>.json`, 원자적 쓰기, 키 모양 검사)
- [ ] 키 계산(spec "키"), callIndex 는 instruction 반복 번호
- [ ] agent: 실행 성공한 툴 호출만 기록(대상은 실행 직전 관찰의 기술자), 끝 anchor(act 전후 새로 나타난 이름 있는 노드, 최대 8), 비밀값은 자리표시로
- [ ] runner: `runTests({ cache: { store, mode } })`, act 성공 시 스테이징, 검증 스텝(expect 통과·assert 참·waitFor 충족) 뒤면 Attempt 끝에 커밋, 실패·미확인은 버림
- [ ] 테스트: FakeEngine 로그인 시나리오로 act → assert 통과면 저장, assert 없음·실패면 저장 안 됨, 비밀값이 항목에 없음
