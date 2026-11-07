# 04: device.dump.ui가 실기기의 트리를 돌려주고, 헬퍼가 꺼져 있으면 device.info가 알려준다

**What to build:** 기기를 꽂으면 디바이스 레이어가 헬퍼 APK 설치, 접근성 서비스 활성화, 포트 포워드, 토큰 발급까지 자동으로 하고 `device.dump.ui`가 실기기의 트리를 돌려준다. 헬퍼가 없거나 꺼져 있으면 `device.info`의 상태 필드로 드러나 러너가 Run을 `blocked` 처리할 수 있다.

**Blocked by:** 01 (ADB 레이어), 03 (헬퍼 APK)

**Status:** ready-for-agent

- [ ] 온보딩: install 서비스로 APK 설치, `settings put secure enabled_accessibility_services`로 활성화, forward로 포트 연결, 브로드캐스트로 토큰 전달. EverMock companion 설치 흐름의 패턴을 따른다
- [ ] `device.dump.ui`가 헬퍼의 `/dump`를 호출해 `SemanticNode`를 돌려준다
- [ ] `device.info`에 헬퍼 상태(설치 안 됨 / 꺼짐 / 준비됨)가 들어가고, `packages/protocol`의 `DeviceInfo` 계약과 계약 테스트가 먼저 갱신된다
- [ ] 페이크 하네스에 헬퍼 HTTP 페이크가 추가되어 온보딩 단계별 실패(설치 실패, 서비스 미활성, 토큰 불일치)를 검증한다
- [ ] 실기기에서 서비스를 껐다 켜면 `device.info`가 바뀌고 `device.dump.ui`가 다시 된다
- [ ] `features/rpc-methods.md`에 `device.dump.ui` 실기기 레시피와 헬퍼 상태 Gotcha가 추가된다
