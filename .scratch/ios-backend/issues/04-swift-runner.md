# 04: Swift XCUITest 러너

**What to build:** `packages/device-layer/ios-runner`: 앱 + UI 테스트 번들, 테스트 안에서 HTTP 서버(Network.framework), 02 계약 구현(XCUIApplication 트리 스냅샷·XCUICoordinate 입력·스크린샷·앱 실행). build-for-testing 스크립트(서명 팀 지정). Xcode 필요.

**Blocked by:** 02

**Status:** done

## 결과 (2026-11-15)

- XcodeGen `project.yml` + `build.sh`(--simulator / --team·--bundle-prefix), Network.framework HTTP 서버, 계약 구현(Runner.swift).
- 화면 크기는 springboard 프레임(테스트 러너 앱의 UIScreen 은 호환 모드 320x480 이라 틀림).
- XCTest 실패(포커스 없는 typeText 등)는 `record` 를 가로채 그 요청의 400 으로 — 러너는 계속 돈다.
- 호스트 기한을 경로별로(`/app` 60초, `/action` 30초, `/dump`·`/snapshot` 20초) — 시뮬레이터 첫 앱 실행이 7~9초.
- iPhone 17 시뮬레이터(iOS 26.3)에서 `scripts/ios-runner-check.ts` 11/11.
- 실기 iPhone XS Max(iOS 17.6.1, 무료 개인 팀 서명) 11/11. 무료 팀은 generic 대상으로는 프로필을 못 만들어(`no devices`) `build.sh --device <udid>`(+ `-allowProvisioningDeviceRegistration`)로 그 기기를 등록한다. 처음 설치 뒤 기기에서 개발자 앱 신뢰 필요.
- iOS 17 설정 앱은 목록 행이 버튼이 아니라 셀(Cell → group)이고 검색창은 당겨야 나온다 — 확인 스크립트가 둘 다 다룬다. 05 에서 셀 역할(탭 가능한 행) 검토.
