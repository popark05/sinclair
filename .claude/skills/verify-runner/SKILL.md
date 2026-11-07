---
name: verify-runner
description: "Sinclair 러너(packages/runner)의 test()/screen/expect 가 실제 Android 기기에서 샘플 테스트를 끝까지 돌리는지 증명한다. 러너·locator·expect·engine-mobile 을 바꿨을 때, 또는 '테스트 스크립트가 실기기에서 도는지 보여 달라'는 요청에 쓴다."
---

# verify-runner

러너는 `runTests(files, { engine })` 로 테스트 파일을 돌린다. 이 스킬은 샘플 테스트 파일을 **실기기** 에서 돌려 리포트(통과/실패, 스텝, 아티팩트)를 증거로 남긴다. 페이크 엔진 검증은 `packages/runner/test/runner.test.ts` 가 `pnpm test` 에서 한다.

## Launch

전제: Android 기기 USB 연결·잠금 해제, 헬퍼 APK 설치(`verify-device-layer` 참고), `adb kill-server`(직접 USB 경로).

```bash
adb kill-server
SINCLAIR_TEST_USB=1 npx vitest run packages/runner/test/runner.device.test.ts
```

준비 완료 기준: vitest 가 테스트를 시작하면 백엔드가 기기를 찾고 헬퍼 온보딩(`ready`)까지 끝낸 것이다.

## Doctor

```bash
SINCLAIR_TEST_USB=1 npx vitest run packages/device-layer/test/android-backend.device.test.ts -t "꽂힌 기기"
```

기기가 `device` 상태로 모델·OS 와 함께 나오면 러너를 돌릴 수 있다. 안 나오면 `adb kill-server`, 케이블, 잠금을 확인한다.

## Drive

- 샘플 파일: `packages/runner/test/fixtures/sample.sinclair.ts` (설정 앱을 열고 "설정" 제목이 보이는지). 다른 흐름을 검증하려면 같은 형식의 파일을 만들고 `runTests([file], { engine })` 로 돌린다(`runner.device.test.ts` 를 본뜬다).
- 안정적인 핸들: `screen.getByText('설정', { exact: true })`, `screen.getByRole('button', { name: '설정 검색' })`. 레시피는 `features/`.

## Evidence

- `.scratch/runner-locator/evidence/05-runner-device-latest.json`(리포에 남음): 기기(시리얼 마스킹), 요약, 테스트별 결과·스텝·소요 시간.
- `.e2e/runner-artifacts/<attemptId>.screenshot.png` / `.screen-tree.json`: 실패한 테스트의 마지막 화면(git-ignore).
- 증명 기준: 사용자 경로(`test()` 파일 → `runTests`)로만 돌리고, 리포트의 `steps` 가 locator/assert 호출을 `step.recorded` 모양으로 담고 있어야 한다. 페이크 엔진 결과는 실기기 증명이 아니다.

## Cleanup

테스트가 끝나면 설정 앱을 종료하고 홈으로 간다. 아티팩트는 지우지 않는다. 다른 직접 USB 테스트를 돌리기 전에 adb server 가 떠 있지 않은지 확인한다.

## Helpers

| 경로 | 역할 |
| --- | --- |
| `packages/runner/test/runner.device.test.ts` | 실기기 실행기(증거 기록 포함) |
| `packages/runner/test/fixtures/sample.sinclair.ts` | 샘플 테스트 |
| `features/` | 기능별 레시피 |

## 검증 이력

- 2026-11-07: 최초 시드. 실기기 실행 결과는 evidence 파일 참고.
