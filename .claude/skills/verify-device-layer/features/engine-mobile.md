# 엔진 경유 (engine-mobile)

러너는 디바이스 RPC 를 직접 부르지 않고 `packages/engine-mobile` 의 `createMobileEngine(rpc, { deviceId, appId })` 로 기기를 조작한다. 이 기능은 그 엔진이 `Engine` 계약(`specs/0002-engine-contract.md`)대로 동작하는지 실기기에서 확인한다.

## Sub-features

- `engine-observe` `observe()` 는 `device.dump.ui` 트리, `observe({ pixels: true })` 는 `device.snapshot`(atomic).
- `engine-locate` `locate(query)` 는 호출마다 새 dump 에 `locateInTree` 를 적용한다.
- `engine-perform` ref 를 기술자(role/testId/name/text/placeholder)로 재매핑하고 rect 가 2회 연속 같을 때 `device.io.tap`, type 은 탭(포커스) 뒤 `device.io.text`.
- `engine-session` `session.open/restart` 는 `device.apps.launch/terminate`, `back` 은 BACK 키.

## How to get to it (user POV)

- 러너 테스트(`screen.getByRole(...).tap()`, 티켓 03~05)가 엔진을 통해 호출한다.
- 직접 검증: 엔진 계약 스위트를 실기기 opt-in 으로 돌린다.

## Driving it with rpc.sh

Preconditions:

- 기기 잠금 해제, `adb kill-server`, 전화 앱(`com.samsung.android.dialer`)이 설치된 Samsung 기기(시나리오가 `digits` 입력 필드와 "검색" 버튼을 전제).

- **계약 스위트.** `SINCLAIR_TEST_USB=1 npx vitest run packages/engine-mobile/test/mobile-engine.device.test.ts`. 12 케이스 통과, 2 케이스는 시나리오에 비활성·secure 노드가 없어 `skipped` 로 표시된다. 요약은 `.scratch/runner-locator/evidence/02-engine-mobile-device-latest.json`.
- **증거.** vitest 출력(케이스별 ✓)과 요약 JSON. 개인정보가 있는 화면(통화 기록, 휴대전화 정보)은 시나리오에 넣지 않는다.

## Gotchas

- 앱 기동 직후 dump 는 런처를 보여줄 수 있다. 스위트는 `session.restart` 뒤 전환 노드가 보일 때까지 기다린다(`navTimeoutMs`, 기본 10초).
- 빈 입력 필드의 `getText` 는 힌트다. 헬퍼가 `isShowingHintText` 를 보고 내용으로 치지 않도록 고쳤다(2026-11-07, 이전에는 "검색wifi" 처럼 힌트 뒤에 덧붙었다).
- 실기기 입력 반영은 수백 ms 걸린다. 입력 직후 재조회는 기한 안에 폴링한다.
- 다른 앱 화면에서는 시나리오 질의가 맞지 않는다. 전화 앱 키패드 탭이 "최근기록" 등 다른 탭으로 바뀌어 있으면 `session.restart` 가 되돌린다.
