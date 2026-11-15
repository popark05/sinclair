# 04: Swift XCUITest 러너

**What to build:** `packages/device-layer/ios-runner`: 앱 + UI 테스트 번들, 테스트 안에서 HTTP 서버(Network.framework), 02 계약 구현(XCUIApplication 트리 스냅샷·XCUICoordinate 입력·스크린샷·앱 실행). build-for-testing 스크립트(서명 팀 지정). Xcode 필요.

**Blocked by:** 02

**Status:** 시뮬레이터 완료 · 실기 서명 대기(ready-for-human: Xcode 에 Apple ID 로그인)

## 결과 (2026-11-15)

- XcodeGen `project.yml` + `build.sh`(--simulator / --team·--bundle-prefix), Network.framework HTTP 서버, 계약 구현(Runner.swift).
- 화면 크기는 springboard 프레임(테스트 러너 앱의 UIScreen 은 호환 모드 320x480 이라 틀림).
- XCTest 실패(포커스 없는 typeText 등)는 `record` 를 가로채 그 요청의 400 으로 — 러너는 계속 돈다.
- 호스트 기한을 경로별로(`/app` 60초, `/action` 30초, `/dump`·`/snapshot` 20초) — 시뮬레이터 첫 앱 실행이 7~9초.
- iPhone 17 시뮬레이터(iOS 26.3)에서 `scripts/ios-runner-check.ts` 11/11.
