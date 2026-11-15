# 05: runner-agent·Studio 연결과 실기 종단

**What to build:** 데몬·Studio 가 Android·iOS 백엔드를 함께(기기 목록에 iOS), engine-mobile 의 iOS 차이(키·뒤로 없음 등), 실기 iPhone 에서 러너 실행·화면 트리·탭·에이전트 act·Studio 세션.

**Blocked by:** 03, 04

**Status:** done

## 결과 (2026-11-15)

- device-layer `routeBackends`(목록 합침, 기기 호출은 그 기기의 백엔드로, 한쪽 실패는 나머지에 영향 없음). 데몬 노드·Studio 작업 프로세스가 Android + iOS(macOS 에서만).
- 러너 빌드는 `SINCLAIR_IOS_XCTESTRUN`, 없으면 리포 산출물(`resolveXctestrun`). 없으면 iPhone 이 '러너 빌드 없음' 사유(unreachable)로 보인다.
- iOS 헬퍼 상태: 띄우기 전엔 없음(필요할 때 띄움 — Fleet 후보를 막지 않음), 띄우는 중 pending, xcodebuild 가 끝나면 unreachable(잠김·신뢰 안 됨 등 사람이 읽을 사유) → 다음 호출에서 다시 띄움. 기다리는 중 끝나면 기한을 기다리지 않는다.
- 데몬 준비: iOS 는 러너를 띄워 홈에서 시작(깨우기·잠금 확인은 Android 만). `--ios-app`(SINCLAIR_AGENT_IOS_APP): iOS 기기의 세션 앱 — Android `--app` 을 iOS 기기에 쓰지 않는다.
- 설치되지 않은 앱의 XCUITest activate 는 러너를 1분 넘게 붙잡아 모든 요청이 밀렸다(실기). 기기 안에서는 설치 여부를 알 수 없어(LSApplicationWorkspace 는 샌드박스로 설정 앱조차 없다고 함, state 는 없는 앱도 notRunning) 호스트가 `xcrun devicectl device info apps`(0.4초, 30초 캐시)로 거른다.
- 실기 iPhone XS Max(iOS 17.6.1): 데몬 Cycle `설정에서 일반 > 키보드 화면을 연다` verified — act 4턴(뒤로·일반·키보드) 18.6초, assert 참. Studio 쪽 RPC: devices.list 에 iPhone ready, snapshot 0.7초, 뒤로 키.

## 남은 것

- ~~iOS 앱 상태 복원~~ → 06 에서 해결.
- iOS 목록 행(Cell)은 group 역할이라 `getByRole('button')` 에 안 걸린다.
- Studio 화면에서 iPhone 세션(실기 UI 확인), 앞 화면 앱은 러너가 띄운 앱만 안다.
- 무료 팀 서명 7일 만료.
