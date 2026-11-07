# 샘플 테스트 실행

QA 가 쓴 `test()` 파일 하나를 러너가 실기기에서 끝까지 돌리고 리포트를 낸다.

## Sub-features

- `run-pass` 통과 테스트의 결과·스텝·소요 시간.
- `run-fail` 실패 테스트의 오류 메시지·코드와 스냅샷 아티팩트.
- `run-skip` `test.skip` 은 세션을 건드리지 않고 skipped.
- `run-restart` 실패한 테스트 직후 앱을 다시 띄우고(restart), 다음 테스트는 open 으로 처음 화면에서 시작한다. `run-blocked` device-unavailable 은 blocked 로 집계되고 Run 은 infra-failed.

## How to get to it (user POV)

- `packages/runner/test/fixtures/sample.sinclair.ts` 같은 파일을 쓰고 `runTests([file], { engine, artifactsDir })` 를 부른다.

## Driving it with runTests

Preconditions:

- Baseline.

- **통과.** `SINCLAIR_TEST_USB=1 npx vitest run packages/runner/test/runner.device.test.ts`. evidence 의 `summary` 가 `{passed:1, failed:0, blocked:0, skipped:0}`, `tests[0].steps` 에 `assert` 스텝(`expect { text="설정", exact=true } toBeVisible`)이 있다.
- **실패·아티팩트(페이크).** `npx vitest run packages/runner/test/runner.test.ts` 의 "통과·실패·skip" 케이스가 `mixed.sinclair.ts` 로 검증한다. 실기기에서 실패를 보려면 샘플 파일에 없는 문구를 기다리는 테스트를 추가한다.

## Gotchas

- 설정 앱 제목은 기기 언어에 따라 다르다(영어 UI 면 "Settings").
- 같은 파일을 한 프로세스에서 두 번 돌릴 때 러너가 import URL 에 run id 를 붙여 다시 평가한다. 테스트 파일은 모듈 최상위에 부수효과를 두지 않는다.
- 실기기 `expect` 기한은 locator 기한의 절반(기본 5초)이다. 콜드 스타트가 느린 앱은 `runTests` 의 `timeoutMs` 를 올린다.
