# Sinclair iOS 러너

iPhone 안에서 화면 트리·스크린샷·입력·앱 실행을 맡는 XCUITest 러너입니다(ios-backend 04). Android 접근성 헬퍼와 같은 HTTP API 모양이며, 호스트 쪽은 `src/ios/runner-client.ts`·`ios-backend.ts` 입니다.

- `RunnerUITests/RunnerTests.swift`: 끝나지 않는 테스트 하나가 HTTP 서버(포트 `SINCLAIR_PORT`, 기본 22087)를 띄웁니다.
- `RunnerUITests/Runner.swift`: 계약(Bearer `SINCLAIR_TOKEN`, `GET /ping·/dump·/snapshot·/app/foreground`, `POST /action·/app`). 좌표는 포인트이고, 호스트가 배율로 픽셀과 바꿉니다.
- `RunnerApp/`: 빈 호스트 앱.

## 빌드

Xcode 와 XcodeGen(`brew install xcodegen`)이 필요합니다. `.xcodeproj` 는 `project.yml` 에서 생성되며 커밋하지 않습니다.

```bash
./build.sh --simulator                                      # 시뮬레이터(서명 없음)
./build.sh --team <TEAM_ID> --device <UDID> --bundle-prefix dev.sinclair.<이름>   # 실기기: Xcode 에 Apple ID 로그인(개인 팀은 --device 필수, 기기를 팀에 등록)
```

마지막 줄에 `.xctestrun` 경로가 나옵니다. 데몬·Studio 는 `SINCLAIR_IOS_XCTESTRUN` 으로 그 경로를 받아 `xcodebuild test-without-building` 으로 러너를 띄웁니다(토큰·포트는 `TEST_RUNNER_SINCLAIR_*` 환경변수).

실기기는 개발자 모드를 켜고 이 Mac 을 신뢰해야 합니다. 개인(무료) 팀 서명은 7일마다 다시 빌드해야 하고, 처음 설치 뒤 iPhone 설정 → 일반 → VPN 및 기기 관리에서 개발자 앱을 신뢰합니다.

## 확인

```bash
TEST_RUNNER_SINCLAIR_TOKEN=t xcodebuild test-without-building -xctestrun <경로> -destination id=<시뮬레이터 udid> &
node --experimental-transform-types packages/device-layer/scripts/ios-runner-check.ts --token t
```

설정 앱으로 ping·토큰 거부·앱 종료/실행·앞 화면 앱·트리·스냅샷·탭(push 화면)·뒤로 제스처·입력과 delete·잘못된 키 거부·홈 버튼을 차례로 확인합니다. 화면 글자는 출력하지 않습니다.

## 제약

- 설치되지 않은 앱을 activate 하면 XCUITest 가 1분 넘게 붙잡아 그동안 모든 요청이 밀립니다. 기기 안에서는 설치 여부를 알 수 없어(샌드박스) 호스트가 `xcrun devicectl device info apps` 로 먼저 거릅니다(`devicectlAppInstalled`).
- iOS 앱은 다시 실행해도 마지막 화면을 복원할 수 있습니다(설정 앱). `app.restart` 가 처음 화면을 보장하지 않습니다.
- 앞 화면 앱은 공개 API 로 물을 수 없어, 이 러너가 띄우거나 활성화한 앱 중 앞에 있는 것으로 셉니다(없으면 홈 = `null`).
- `launch` 는 이미 떠 있으면 앞으로만 가져옵니다. 처음부터 시작하려면 호스트가 terminate 뒤 launch 합니다.
- XCUITest 는 동작마다 앱이 잠잠해지길 기다려 Android 보다 느립니다(앱 실행 수 초, 입력 수 초).
- 볼륨 버튼은 실기기에서만, 전원 버튼과 방향키는 지원하지 않습니다.
