# 05: `test()` API 와 최소 러너로 샘플 테스트가 실기기에서 돈다

**What to build:** QA 가 `test('설정에서 Wi-Fi 화면을 연다', async ({ app, screen }) => { … })` 를 쓰고, 러너가 그것을 FakeEngine 과 실기기 양쪽에서 실행해 결과(StepRecord, 실패 시 스냅샷)를 낸다. 에이전트 없이도 결정적 테스트를 작성·실행할 수 있는 첫 수직 슬라이스.

**Blocked by:** 02 (engine-mobile), 03 (locator), 04 (expect)

**Status:** done

- [x] `test(name, fn)`, `test.describe`, `test.skip`, fixture `{ app, screen, expect }` (`app.open(target?)`, `app.back()`, `app.restart()` 는 엔진 `session` capability 로. `expect` 를 fixture 로 주는 이유: 스텝 기록이 현재 테스트에 붙어야 해서)
- [x] 워커당 엔진 1개, 테스트마다 `session.open` 으로 시작, 실패한 테스트 뒤에는 `restart`
- [x] 결과 리포트: 테스트별 passed/failed/skipped, 스텝 목록(locator/expect 호출을 `step.recorded` 이벤트 모양으로, 소요 시간), 실패 시 마지막 `snapshot` 아티팩트 경로. 이벤트 모양은 protocol 의 계약 테스트와 일치
- [x] 프로그램 방식 실행기 `runTests(files, { engine })` 가 vitest 와 독립적으로 동작한다(CLI 는 범위 밖)
- [x] 샘플 테스트 1개(런처 → 설정 앱 열기 → `expect(screen.getByText(...)).toBeVisible()`)가 FakeEngine(시뮬레이션 트리)과 실기기 opt-in 에서 통과하고, 실기기 결과 요약이 `.scratch/runner-locator/evidence/` 에 남는다
- [x] `verify-runner` 검증 스킬 시드: 샘플 테스트를 실기기에서 돌려 증거를 남기는 절차와 feature map 1개

## Comments

- 2026-11-07: 완료. `test`(등록 레지스트리, describe 경로를 " > " 로 이음, skip), `runTests(files, { engine, artifactsDir, timeoutMs, runId… })`: 파일을 run 마다 다른 질의 문자열로 import 해 등록을 모으고, 테스트마다 `session.open`(직전 실패면 `restart`), 실패 시 `observe({pixels:true})` 로 PNG + 트리 JSON 아티팩트, 리포트 `{ runId, tests[], summary, events[] }`. 스텝은 `createScreen`/`expect` 의 `onStep` 훅으로 `step.recorded` 모양(kind locator/assert, instruction, durationMs, modelCalls 0)으로 쌓이고 events 는 protocol `RunEvent` 순서(run.started → attempt.started → step.recorded* → attempt.finished → run.finished). 실패 코드: EngineError 코드 / `assertion` / `error`, `device-unavailable` 이면 결과 `blocked`. FakeEngine 테스트 4개(샘플 통과·스텝, 통과·실패·skip·아티팩트·요약, 이벤트 모양·순서·id 유일, 세션 순서). 실기기 SM-N981N: 샘플 테스트 통과 1.3s, evidence `05-runner-device-latest.json`. `verify-runner` 스킬 시드(SKILL.md + features).
- 결정: 리포트의 skipped 는 세션을 건드리지 않는다. secure 입력값은 스텝 instruction 에 `type(…)` 로만 남고 값은 기록하지 않는다(03 에서 넘어온 검증 항목).
