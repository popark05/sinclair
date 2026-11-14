# iOS 백엔드 (2026-11-15 결정)

## 결정
- 온디바이스: **자체 XCUITest 러너**(Swift UI 테스트 번들이 기기 안에서 HTTP 서버를 연다). Android 헬퍼와 같은 모양의 HTTP API(`/ping`·`/dump`·`/snapshot`·`/action`, 앱 실행·종료·앞 화면 앱) — 호스트 쪽 규칙을 공유한다. mobilenext devicekit-ios 는 FSL 이라 설계(테스트 번들 안 HTTP 서버)만 참고, 코드는 가져오지 않는다.
- 호스트 ↔ 기기: usbmuxd(macOS 기본) — 기기 목록·연결 알림(Listen)·기기 포트로 터널(Connect). lockdownd 의 기본 값(이름·모델·iOS 버전)은 페어링 없이(simple) 읽는다. 직접 구현(작은 plist 프로토콜) — 외부 바이너리(go-ios 등) 없이.
- 러너 실행: 처음엔 호스트의 `xcodebuild test-without-building -destination id=<udid>`(Xcode 필요). testmanagerd(DTX) 직접 구현은 범위 밖(필요하면 나중).
- 환경: Xcode 설치 예정, Apple ID 서명(개인 팀이면 7일마다 재서명), 테스트용 iPhone(iOS 16+ 개발자 모드).

## 순서
A. 기기 없이(가짜): 01 usbmux·lockdown 클라이언트, 02 러너 HTTP 계약·호스트 클라이언트·트리 변환, 03 iOS DeviceBackend(러너 실행기 주입).
B. Xcode·iPhone 준비 후: 04 Swift 러너(빌드·서명 스크립트), 05 runner-agent·Studio 연결과 실기 종단.
