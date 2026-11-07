# Android 백엔드 실제 구현

CLAUDE.md 작업 로그의 다음 티켓 1번. 근거: `specs/0001-architecture.md` 디바이스 레이어 절, `docs/adr/0003-android-ui-access.md`.

- EverMock 리포(`../http.proxy.moker/src/main/adb`, dadb 포트, Apache-2.0)의 direct ADB 레이어와 `test/main/adb` 페이크 하네스를 `packages/device-layer`로 이식한다.
- 접근성 헬퍼 APK는 독자 구현한다. artemis(`reference/artemis/packages/artemis-accessibility-helper`)는 설계만 참고하고 코드를 복사하지 않는다.
- 입력 주입은 1차 접근성 제스처, fallback `adb shell input`.
- 헬퍼가 꺼져 있으면 `device.info`로 드러내고 Run을 `blocked` 처리한다.
- 모든 티켓은 `verify-device-layer` 스킬의 feature map을 실백엔드 기준으로 갱신한다.

티켓은 `issues/`에 있다. 의존 순서: 01 → 02, 03 → 04 → 05, 06.
