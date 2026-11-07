# 05: 스크린샷과 트리가 같은 순간에 찍힌다 (/snapshot)

**What to build:** `device.screenshot`과 `device.dump.ui`를 한 번에 요청하면 헬퍼가 API 30+ `takeScreenshot`과 트리 덤프를 같은 순간에 수행해 돌려준다. 녹화 캐시 재생의 앵커 검사가 "그 트리의 그 화면"을 전제로 할 수 있다. Android 11 미만이나 실패 시 02의 screencap 경로로 떨어진다.

**Blocked by:** 04 (헬퍼 연결)

**Status:** ready-for-agent

- [ ] 헬퍼에 `/snapshot`이 추가되고 응답에 스크린샷(PNG base64)과 트리가 함께 들어가며, 디바이스 RPC에 이를 노출하는 메서드가 `packages/protocol`의 메서드 목록과 계약 테스트에 먼저 추가된다
- [ ] 스크린샷 rate limit(약 333 ms)에 걸리면 재시도하고, 그래도 실패하면 응답에 원자성이 깨졌음을 표시하고 screencap으로 fallback 한다
- [ ] `device.screenshot` 단독 호출도 헬퍼 경로를 우선하고 미지원 시 screencap을 쓴다
- [ ] 실기기에서 애니메이션 중 `/snapshot`을 찍어 트리의 bounds와 스크린샷의 요소 위치가 일치함을 증거로 남긴다
- [ ] feature map에 스냅샷 레시피와 Android 버전 Gotcha가 추가된다
