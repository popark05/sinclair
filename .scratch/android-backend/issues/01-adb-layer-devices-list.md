# 01: USB로 연결된 Android 기기가 devices.list에 나온다

**What to build:** 사용자가 Android 기기를 USB로 꽂으면 디바이스 레이어의 `devices.list`에 그 기기가 `device` / `unauthorized` / `offline` 상태와 모델·OS 버전과 함께 나오고, `device.info`로 하나를 조회할 수 있다. adb 바이너리나 adb 서버 없이 직접 USB 연결로 동작한다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] EverMock의 direct ADB 레이어(dadb 포트)와 `test/main/adb`의 페이크(fake-android, fake-usb, fake-adb-server)가 `packages/device-layer`로 이식되고 NOTICE(Apache-2.0)가 함께 옮겨진다
- [ ] `usb` 의존성과 타깃별 node-usb 바이너리 fetch 스크립트가 워크스페이스에 들어오고 `pnpm install` 후 `pnpm check`가 통과한다
- [ ] `AndroidBackend`가 `DeviceBackend`의 `listDevices`/`info`를 구현하고, 페이크 하네스 테스트로 세 상태를 검증한다
- [ ] 프리팩터: 디스패처의 기기 탐색이 호출마다 `listDevices`를 돌지 않도록 백엔드가 기기 조회를 캐시한다(USB 열거는 느리다)
- [ ] 실기기 테스트(`ADB_TEST_USB=1` 류 opt-in)로 Samsung 등 실제 기기가 `devices.list`에 나온다
- [ ] `verify-device-layer`의 `serve.ts`에 실백엔드 모드가 추가되고 `features/rpc-methods.md`가 실기기 기준으로 갱신된다
