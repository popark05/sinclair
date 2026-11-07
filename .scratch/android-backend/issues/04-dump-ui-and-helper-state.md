# 04: device.dump.ui가 실기기의 트리를 돌려주고, 헬퍼가 꺼져 있으면 device.info가 알려준다

**What to build:** 기기를 꽂으면 디바이스 레이어가 헬퍼 APK 설치, 접근성 서비스 활성화, 포트 포워드, 토큰 발급까지 자동으로 하고 `device.dump.ui`가 실기기의 트리를 돌려준다. 헬퍼가 없거나 꺼져 있으면 `device.info`의 상태 필드로 드러나 러너가 Run을 `blocked` 처리할 수 있다.

**Blocked by:** 01 (ADB 레이어), 03 (헬퍼 APK)

**Status:** done

- [x] 온보딩: install 서비스로 APK 설치, `settings put secure enabled_accessibility_services`로 활성화, forward로 포트 연결, 브로드캐스트로 토큰 전달. EverMock companion 설치 흐름의 패턴을 따른다
- [x] `device.dump.ui`가 헬퍼의 `/dump`를 호출해 `SemanticNode`를 돌려준다
- [x] `device.info`에 헬퍼 상태(설치 안 됨 / 꺼짐 / 준비됨)가 들어가고, `packages/protocol`의 `DeviceInfo` 계약과 계약 테스트가 먼저 갱신된다
- [x] 페이크 하네스에 헬퍼 HTTP 페이크가 추가되어 온보딩 단계별 실패(설치 실패, 서비스 미활성, 토큰 불일치)를 검증한다
- [x] 실기기에서 서비스를 끄면 다음 `device.dump.ui` 가 자동으로 다시 켜고 트리를 돌려준다(실기기 확인). 자동 재활성화까지 거부되는 경우의 `disabled` 전이는 페이크로 검증
- [x] `features/rpc-methods.md`에 `device.dump.ui` 실기기 레시피와 헬퍼 상태 Gotcha가 추가된다

## Comments

- 2026-11-07: 완료. 결정: 온보딩은 연결 판정 직후 자동(설치 → `settings put --user 0` → forward → 토큰 → `/ping`), 실패는 `device.info.helper` 상태로만 드러내고 연결 상태에는 영향 없음. `device.dump.ui` 는 미준비면 재온보딩 후 시도, 불가면 `-32002 helperUnavailable`. 실기기 SM-N981N: 온보딩 ready + dump(홈 화면) 통과, adb 로 서비스를 끈 뒤에도 다음 호출에서 자동 재활성화·dump 성공(1.8s). 페이크 테스트 8개(전체 성공, 재설치 안 함, 설치 실패, 설정 거부, 토큰 누락→복구, 끔→켬, RPC -32002).
