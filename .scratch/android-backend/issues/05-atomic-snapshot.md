# 05: 스크린샷과 트리가 같은 순간에 찍힌다 (/snapshot)

**What to build:** `device.screenshot`과 `device.dump.ui`를 한 번에 요청하면 헬퍼가 API 30+ `takeScreenshot`과 트리 덤프를 같은 순간에 수행해 돌려준다. 녹화 캐시 재생의 앵커 검사가 "그 트리의 그 화면"을 전제로 할 수 있다. Android 11 미만이나 실패 시 02의 screencap 경로로 떨어진다.

**Blocked by:** 04 (헬퍼 연결)

**Status:** done

- [x] 헬퍼에 `/snapshot`이 추가되고 응답에 스크린샷(PNG base64)과 트리가 함께 들어가며, 디바이스 RPC에 이를 노출하는 메서드가 `packages/protocol`의 메서드 목록과 계약 테스트에 먼저 추가된다
- [x] 스크린샷 rate limit(약 333 ms)에 걸리면 재시도하고, 그래도 실패하면 응답에 원자성이 깨졌음을 표시하고 screencap으로 fallback 한다
- [x] `device.screenshot` 단독 호출도 헬퍼 경로를 우선하고 미지원 시 screencap을 쓴다
- [x] 실기기에서 최근 앱 전환 애니메이션 중 `device.snapshot` 을 찍어 `atomic:true`, PNG 폭·높이 = 루트 `rect`, PNG 가 300KB 이상(검은 화면 배제), 화면 안에 놓인 이름 있는 리프가 3개 이상임을 확인하고 `.e2e/device-proof/*-snapshot.{png,json}`(원본) 과 `.scratch/android-backend/evidence/05-snapshot-latest.json`(리포에 남는 요약) 으로 남긴다. 요소 단위 픽셀 비교는 범위 밖
- [x] feature map에 스냅샷 레시피와 Android 버전 Gotcha가 추가된다

## Comments

- 2026-11-07: 완료. protocol 에 `device.snapshot` + `SnapshotResult` 계약 테스트 먼저. 헬퍼 `/snapshot`(takeScreenshot API 30+, 간격 제한 1회 재시도, 실패 시 트리만 atomic:false). 백엔드 `snapshot` 은 헬퍼 우선·screencap fallback, `screenshot` 도 헬퍼 우선. 페이크 테스트 6개. 실기기 SM-N981N(API 33): 전환 애니메이션 중 atomic:true, 2.8MB PNG 1080×2400 = root rect.
- 실기기에서 드러난 전송 결함 2개 수정(단위 테스트로 재현): (1) 일부 adbd 가 헤더+본문을 한 전송으로 보내 한 패킷에 섞이면 node-usb 가 요청 길이로 잘라 데이터가 사라짐 → 헤더는 패킷 단위로 요청하고 초과분을 pending 버퍼로. (2) node-usb 3(nusb) 는 timeout 취소 순간 도착한 패킷을 버림 → 1초 유휴 폴링이 헬퍼의 ~1초 응답과 겹쳐 WRTE 헤더가 사라지던 것. 유휴 읽기 timeout 을 60초로 올리고 종료는 wake OPEN 으로 기기 응답을 받아 취소 없이 끝냄. 보류 읽기가 있으면 인터페이스를 놓을 수 없는(native borrow) 제약도 확인. 수정 후 실기기 전체 스위트 7회 중 6회 통과, 1회는 IOKit USB 오류(0xE000404D, 기기 연결 끊김으로 분류)로 실패했고 재현되지 않음.
- 2026-11-07 리뷰 반영: (1) 헬퍼 `/snapshot` 이 콜백을 기다린 뒤 트리를 읽어 "같은 순간" 이 아니었음 → `takeScreenshot` 호출 직후(콜백·PNG 인코딩 전) 트리를 읽도록 `ScreenCapture.capture(service, dumpTree)` 로 재구성. (2) 증거 기준이 약해 잠금화면의 검은 16KB 캡처가 통과하던 것 → PNG ≥300KB, 화면 안 이름 있는 리프 ≥3 을 요구하고 리포에 남는 요약 파일 추가. 잠금화면(keyguard)에서는 `takeScreenshot` 이 검게 나오므로 테스트가 WAKEUP 뒤 MENU 로 잠금을 넘긴다. (3) 콜백 try/catch(바인더 스레드 예외로 서비스가 죽지 않게), errorCode 상수 비교, 하드웨어 비트맵 recycle. (4) USB shutdown 의 wake OPEN 을 오류 경로에서도 보내도록, 상수 설명 보강, `HelperSnapshot` 을 `SnapshotResult` 에서 파생. 헬퍼 재시도 로직은 헬퍼 단위 테스트가 없어 페이크로만 덮임(미결).
