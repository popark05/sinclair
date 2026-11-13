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
- 에이전트 샘플: `packages/runner/test/fixtures/agent-device.sinclair.ts` 를 `agent.device.test.ts` 로(실제 모델은 `SINCLAIR_AGENT_LIVE=1` + 키, 없으면 대본 실행기로 배관만). 레시피 `features/agent.md`.
- 안정적인 핸들: `screen.getByText('설정', { exact: true })`, `screen.getByRole('button', { name: '설정 검색' })`. 레시피는 `features/`.

## Evidence

- `.scratch/runner-locator/evidence/05-runner-device-latest.json`(리포에 남음): 기기(시리얼 마스킹), 요약, 테스트별 결과·스텝·소요 시간.
- `.scratch/runner-locator/evidence/05-runner-retry-device-latest.json`: 재시도(`retries: 1`) 샘플 `fixtures/sample-flaky.sinclair.ts`(fixture `attemptNo` 가 1 이면 없는 문구를 기다려 실패) 의 attempt 시퀀스 — `started 1 → finished failed(아티팩트) → started 2 → finished passed`, `attempts: 2`. control-plane 에 보고되면 그 셀은 `passed-flaky` 다.
- `.scratch/agent-layer/evidence/08-agent-device-<live|scripted>-latest.json`: 에이전트 샘플의 스텝(act/assert)·modelCalls·usage·소요 시간, 실패 테스트의 턴 한도 사유·아티팩트 종류, 비밀값 검사(리포트·모델 요청·screen-tree 에 값 없음). 키·시리얼·판정 근거 문구 없음.
- `.e2e/runner-artifacts/<attemptId>.screenshot.png` / `.screen-tree.json`: 실패한 테스트의 마지막 화면(git-ignore).
- 증명 기준: 사용자 경로(`test()` 파일 → `runTests`)로만 돌리고, 리포트의 `steps` 가 locator/assert 호출을 `step.recorded` 모양으로 담고 있어야 한다. 페이크 엔진 결과는 실기기 증명이 아니다.

## Cleanup

테스트가 끝나면 설정 앱을 종료하고 홈으로 간다. 아티팩트는 지우지 않는다. 다른 직접 USB 테스트를 돌리기 전에 adb server 가 떠 있지 않은지 확인한다.

## Helpers

| 경로 | 역할 |
| --- | --- |
| `packages/runner/test/runner.device.test.ts` | 실기기 실행기(증거 기록 포함) |
| `packages/runner/test/fixtures/sample.sinclair.ts` | 샘플 테스트 |
| `packages/runner/test/fixtures/sample-flaky.sinclair.ts` | 재시도 샘플(첫 시도만 실패) |
| `packages/runner/test/agent.device.test.ts` | 실기기 에이전트 종단(실제 모델 또는 대본 실행기) |
| `packages/runner/test/fixtures/agent-device.sinclair.ts` | 에이전트 샘플(목표+판정·비밀값·이룰 수 없는 목표) |
| `features/` | 기능별 레시피 |

## 검증 이력

- 2026-11-07: 최초 시드. 실기기 실행 결과는 evidence 파일 참고.
- 2026-11-08: 재시도 샘플 추가(retry-policy 티켓 01). SM-N981N 에서 passed/attempts 2 확인.
- 2026-11-09: 에이전트 feature(agent-layer 08). SM-N981N 에서 대본 실행기로 배관 확인(passed 2·failed 1, 비밀값 검사 통과, left-app 알림 1). 같은 날 실제 모델(claude-sonnet-5-5)로 통과(71초, 모델 호출 25, 안전망 개입 3, 비밀값 검사 통과) — live 증거.
- 2026-11-14: 실제 모델로 YouTube 검색(데몬 `--engine mobile --app com.google.android.youtube` + control-plane Cycle) — 결함 둘(입력 확정 툴 없음 → `submit`, 입력값 반영 지연으로 중복 입력 → engine-mobile type 대기)을 찾아 고친 뒤 type→submit 경로로 통과. 증거 `.scratch/agent-layer/evidence/09-youtube-search-live-latest.json`. 앱 상태가 남으면(검색창 글자·검색 기록) 그 경로를 지나지 않으니 테스트는 `app.restart()` 와 기록에 없는 검색어로.
- 2026-11-14: 녹화 캐시 실기기 종단 — 데몬(`--cache` 기본 read-write) + control-plane SQLite 공유 저장으로 YouTube 검색 녹화(라이브) → 재생(act 모델 0) → 녹화 변조로 이어받기 → 다시 재생. 증거 `.scratch/recording-cache/evidence/07-device-latest.json`. 녹화를 다시 만들려면 정책을 올리거나 `DELETE /cache/:key`.
