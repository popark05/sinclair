# 02: 헬퍼 없이 adb shell만으로 탭·텍스트·앱 실행·스크린샷이 된다

**What to build:** 접근성 헬퍼가 설치되지 않은 기기에서도 `device.io.tap/longpress/swipe/text/keys/button`, `device.apps.launch/terminate`, `device.url`, `device.screenshot`이 실기기에서 동작한다. ADR 0003의 "좌표 탭 fallback" 경로이며 이후 티켓의 안전망이다.

**Blocked by:** 01 (ADB 레이어와 AndroidBackend)

**Status:** ready-for-agent

- [ ] 입력 메서드가 `adb shell input` 계열로, 앱 제어가 `am start` / `am force-stop` / 딥링크 `am start -a VIEW`로, 스크린샷이 `screencap -p`로 구현된다
- [ ] 텍스트 입력은 공백·특수문자·한글을 깨지지 않게 전달한다(페이크 테스트로 이스케이프 고정)
- [ ] 페이크 하네스가 shell 호출을 기록해 `backend-calls.log`와 같은 형식으로 순서를 검증한다
- [ ] 실기기에서 `device.io.tap` 뒤 `device.screenshot`으로 화면 변화가 증거로 남는다
- [ ] `features/device-io.md`, `features/apps-and-url.md`가 실기기 기준으로 갱신된다(스와이프 파라미터 키 이름 결정 포함)
