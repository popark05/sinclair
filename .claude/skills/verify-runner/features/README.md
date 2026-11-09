# runner verification map

러너(`test()`/`screen`/`expect`/`runTests`)가 실기기에서 어떻게 동작해야 하는지의 유지 소스.

## Baseline preconditions

- `verify-runner` SKILL.md 의 Launch 전제(기기·헬퍼·adb kill-server).
- 샘플 파일은 한국어 UI 의 설정 앱을 전제한다.

## Driving conventions

- 모든 검증은 `test()` 파일을 `runTests` 로 돌리는 사용자 경로로 한다. 엔진이나 디바이스 RPC 를 직접 부르면 러너 검증이 아니다.
- 결과는 리포트(`summary`, `tests[].steps`, `artifacts`)로 판정한다.

## Proof and skip reporting

- 통과 증거: evidence JSON 의 `summary.passed` 와 스텝 목록. 실패 증거: `.e2e/runner-artifacts` 의 스냅샷과 `error`.
- 도달 불가(기기 없음·잠금)는 그 사유를 적고 skip 으로 보고한다.

## Features

- [샘플 테스트 실행](./sample-test.md): 설정 앱 열기 → 제목 판정. 리포트·스텝·아티팩트.
- [에이전트 실기기 종단](./agent.md): agent.act·assert 실제 모델(또는 배관용 대본 실행기), 비밀값, 이룰 수 없는 목표의 실패.
