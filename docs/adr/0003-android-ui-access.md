# 0003. Android UI 접근은 접근성 서비스 방식을 기본으로 한다

- 상태: 승인
- 날짜: 2026-11-07

## 맥락
Android에서 UI 트리와 입력을 얻는 방식은 두 가지다.
1. **UiAutomation 독점** (mobilecli 방식): shell 사용자로 `app_process` dex를 띄워 UiAutomation을 잡는다. 설치가 필요 없지만 기기의 유일한 UiAutomation을 점유해 Appium, Espresso, Maestro 등과 공존하지 못한다.
2. **접근성 서비스** (artemis 방식): 접근성 서비스 APK를 설치하고 adb forward로 HTTP/RPC를 받는다. UiAutomation을 쓰지 않아 다른 도구와 공존하고, API 30+에서는 스크린샷과 트리를 같은 순간에 반환할 수 있다. 사용자가 접근성 설정에서 서비스를 켜야 한다(adb `settings put`으로 자동화 가능).

## 결정
접근성 서비스 방식을 기본으로 한다. 온디바이스 에이전트(`packages/device-layer`의 Android 백엔드가 말을 거는 APK)는 독자 구현한다. 입력 주입은 1차로 접근성 제스처 API, 좌표 탭 fallback은 `adb shell input`.

## 이유
- 사내 QA 환경에서는 같은 기기에 다른 자동화 도구가 붙는 경우가 있어 공존이 중요하다.
- 스크린샷·트리 원자성은 캐시 재생의 앵커 검사에 필요하다.
- UiAutomation 독점 방식은 FSL 라이선스 코드를 참고해야 하는 부담이 크다.

## 결과
- APK 설치와 접근성 서비스 활성화 단계가 기기 onboarding에 추가된다. EverMock의 companion APK 설치 흐름을 재사용한다.
- 서비스가 꺼져 있으면 `device.info`의 상태로 드러내고 Run을 `blocked` 처리한다.
