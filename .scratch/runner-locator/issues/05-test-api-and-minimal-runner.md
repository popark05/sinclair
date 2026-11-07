# 05: `test()` API 와 최소 러너로 샘플 테스트가 실기기에서 돈다

**What to build:** QA 가 `test('설정에서 Wi-Fi 화면을 연다', async ({ app, screen }) => { … })` 를 쓰고, 러너가 그것을 FakeEngine 과 실기기 양쪽에서 실행해 결과(StepRecord, 실패 시 스냅샷)를 낸다. 에이전트 없이도 결정적 테스트를 작성·실행할 수 있는 첫 수직 슬라이스.

**Blocked by:** 02 (engine-mobile), 03 (locator), 04 (expect)

**Status:** ready-for-agent

- [ ] `test(name, fn)`, `test.describe`, `test.skip`, fixture `{ app, screen }` (`app.open(target?)`, `app.back()`, `app.restart()` 는 엔진 `session` capability 로)
- [ ] 워커당 엔진 1개, 테스트마다 `session.open` 으로 시작, 실패한 테스트 뒤에는 `restart`
- [ ] 결과 리포트: 테스트별 passed/failed/skipped, 스텝 목록(locator/expect 호출을 `step.recorded` 이벤트 모양으로, 소요 시간), 실패 시 마지막 `snapshot` 아티팩트 경로. 이벤트 모양은 protocol 의 계약 테스트와 일치
- [ ] 프로그램 방식 실행기 `runTests(files, { engine })` 가 vitest 와 독립적으로 동작한다(CLI 는 범위 밖)
- [ ] 샘플 테스트 1개(런처 → 설정 앱 열기 → `expect(screen.getByText(...)).toBeVisible()`)가 FakeEngine(시뮬레이션 트리)과 실기기 opt-in 에서 통과하고, 실기기 결과 요약이 `.scratch/runner-locator/evidence/` 에 남는다
- [ ] `verify-runner` 검증 스킬 시드: 샘플 테스트를 실기기에서 돌려 증거를 남기는 절차와 feature map 1개
