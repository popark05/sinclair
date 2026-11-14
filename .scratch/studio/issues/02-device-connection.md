# 02: 기기 연결 — 작업 프로세스의 디바이스 서버, 기기 선택

**What to build:** 작업 프로세스가 디바이스 서버를 열거나(기본) 데몬의 로컬 디바이스 RPC 에 붙고(발견 파일), 툴바의 기기 선택(목록·상태·헬퍼 준비)과 앱 선택을 채운다.

**Blocked by:** 01

**Status:** done

- [x] 데몬 발견: 데몬이 로컬 RPC 포트·토큰을 OS 데이터 디렉터리에 남기고 Studio 가 읽음(권한 0600). 없으면 직접 연다
- [x] 기기 목록·상태(device·unauthorized·offline, 헬퍼), 선택 유지, 앱 id(설치된 앱 목록 대신 '현재 앱' 채우기 — 아래)
- [x] 테스트: 페이크 백엔드 디바이스 서버로 목록·선택, 발견 파일 경로

## Comments

- 2026-11-14 구현. device-layer `discovery.ts`: `publishDeviceRpc`(0600, 원자적)·`readDeviceRpc`(죽은 pid 는 없는 것)·`unpublishDeviceRpc`(내 pid 만)·`defaultDiscoveryFile`(OS 데이터 디렉터리/sinclair/device-rpc.json). runner-agent 데몬(mobile)이 백엔드를 열면 로컬 디바이스 RPC 를 열고 발견 파일을 남기며 끝날 때 지운다(강제 종료로 남아도 pid 검사로 무시).
- Studio 작업 프로세스 `device-session.ts` `connectDevices`: 발견 파일의 데몬이 2초 안에 `devices.list` 에 답하면 데몬 모드, 아니면 직접(Android 백엔드 + 디바이스 서버, 헬퍼 APK 는 `SINCLAIR_STUDIO_HELPER_APK` 또는 리포 빌드), 둘 다 안 되면 none + 사유. IPC 를 요청/응답(`StudioRequest` 닫힌 집합: connection·devices·foreground-app, 메인이 `parseStudioRequest` 로 거름)으로 넓힘.
- 앱: 설치된 앱 목록 RPC 가 없어(`device.apps.foreground` 도 이름만) '현재 앱' 버튼이 화면 트리의 리소스 id 패키지(agent `appPackageOf`)로 채운다. 프로토콜 계약은 넓히지 않음.
- 툴바(AppShell topNav, astryx TopNav·Selector·TextInput·Button): 기기 `모델 (…끝 4자리)`·상태 설명·쓸 수 없는 기기 비활성, 첫 쓸 수 있는 기기 자동 선택, 연결 방식(데몬·직접·연결 없음 + 사유), 새로 고침.
- 실기에서 찾아 고친 것: (1) 렌더러가 작업 프로세스 준비 전에 물어 거부됨 → 띄우는 중의 요청은 준비될 때까지 기다림(테스트 추가), (2) Electron 의 Node 와 plain Node 의 V8 직렬화 버전이 달라 `serialization: 'advanced'` 메시지를 풀지 못함 → `json`. 작업 프로세스는 TS 워크스페이스 패키지를 쓰므로 `--experimental-transform-types`(리포 실행 — 설치본은 번들로).
- 실제 Electron 실행 캡처: 데몬이 떠 있을 때 "데몬" + SM-N981N(…XLZW) 자동 선택, 데몬을 멈추면 "직접" 으로 같은 기기. Studio 를 닫으면 작업 프로세스도 끝남.
