# 02: engine-mobile — 디바이스 레이어 위의 Engine

**What to build:** `createMobileEngine(deviceRpc, { deviceId })` 가 실제 Android 기기에서 `Engine` 계약을 구현한다. 러너는 이것 하나로 기기를 조작하며, 01 의 계약 스위트를 FakeBackend 서버와 실기기 양쪽에서 통과한다.

**Blocked by:** 01 (계약 스위트)

**Status:** ready-for-agent

- [ ] `observe` 는 `device.snapshot`(원자 캡처)을 쓰고 `atomic:false` 면 Observation 에 그 사실을 남긴다. `pixels` 는 요청 시에만
- [ ] `locate` 는 마지막 observe 의 트리를 질의하고, `testId` 는 resource-id 전체/짧은 이름 모두에 매칭(mobilewright 방식), 같은 bounds 가 2회 연속이면 actionable 로 본다
- [ ] `perform` 은 ref 의 rect 중심을 `device.io.tap/longpress` 로, `type` 은 노드를 탭해 포커스한 뒤 `device.io.text` 로, `scroll` 은 `device.io.swipe` 로. ref 가 stale 이면 `not-found`
- [ ] capability: `performAt`(pointer), `keyboard`(type/press/dismiss = BACK), `session`(open = `device.apps.launch`, back, restart = terminate+launch, reset = `pm clear` 는 범위 밖으로 명시)
- [ ] 디바이스 레이어 오류(`-32000` 기기 없음, `-32002` 헬퍼 없음)가 `EngineError` 로 변환되고 메시지에 기기 id 가 남는다
- [ ] 계약 스위트가 FakeBackend 기반 JSON-RPC 서버에서 통과하고, 실기기 opt-in(`SINCLAIR_TEST_USB=1`)으로 설정 앱에서 통과한다
- [ ] `verify-device-layer` feature map 에 엔진 경유 레시피가 1개 추가된다
