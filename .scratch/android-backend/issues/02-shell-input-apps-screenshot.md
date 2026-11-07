# 02: 헬퍼 없이 adb shell만으로 탭·텍스트·앱 실행·스크린샷이 된다

**What to build:** 접근성 헬퍼가 설치되지 않은 기기에서도 `device.io.tap/longpress/swipe/text/keys/button`, `device.apps.launch/terminate`, `device.url`, `device.screenshot`이 실기기에서 동작한다. ADR 0003의 "좌표 탭 fallback" 경로이며 이후 티켓의 안전망이다.

**Blocked by:** 01 (ADB 레이어와 AndroidBackend)

**Status:** in-progress (실기기 검증만 남음)

- [x] 입력 메서드가 `adb shell input` 계열로, 앱 제어가 `monkey -p … -c LAUNCHER`(appId 만 받으므로 `am start -n` 불가) / `am force-stop` / 딥링크 `am start -a VIEW`로, 스크린샷이 `screencap -p`로 구현된다
- [x] 텍스트 입력은 공백·특수문자를 깨지지 않게 전달한다(페이크 테스트로 이스케이프 고정). 한글 등 비ASCII 는 `input text` 로 불가하므로 `-32602` 로 명확히 거부한다(티켓 06 의 헬퍼 setText 가 맡음). 리터럴 `%s` 는 `input text` 의 한계로 전달 불가
- [x] 페이크 하네스가 shell 호출을 `FakeAndroid.shellCommands` 에 기록해 정확한 명령 문자열과 순서를 검증한다(`backend-calls.log` 형식은 verify 스킬의 페이크 전용이라 쓰지 않음)
- [ ] 실기기에서 홈 → 스크린샷 → 최근 앱 키 → 스크린샷으로 화면 변화가 `.e2e/device-proof/*-{before,after}.png` 에 증거로 남는다
- [x] `features/device-io.md`, `features/apps-and-url.md`가 실기기 기준으로 갱신된다(스와이프 파라미터 키 이름 결정 포함)

## Comments

- 2026-11-07: 구현 완료. 결정 사항: (1) `input text` 는 ASCII 만 지원하므로 비ASCII 는 `-32602` 로 명확히 거부(한글은 티켓 06 헬퍼 setText). (2) `launchApp` 은 appId 만 받아 `am start -n` 대신 `monkey -p … -c LAUNCHER 1`. (3) 스와이프 키 `fromX/fromY/toX/toY` 확정. 실기기 항목은 `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run packages/device-layer/test/android-backend.device.test.ts` 로 검증(홈 → 탭 → 스크린샷 PNG → text → back).
- 2026-11-07 리뷰 반영: `keys` 화이트리스트(셸 삽입 차단), `runBinary` 스트림 close, 기기 없음 오류 코드 통일, 실기기 테스트가 전후 스크린샷을 저장하도록 보강.
