# 02: engine-mobile — 디바이스 레이어 위의 Engine

**What to build:** `createMobileEngine(deviceRpc, { deviceId })` 가 실제 Android 기기에서 `Engine` 계약을 구현한다. 러너는 이것 하나로 기기를 조작하며, 01 의 계약 스위트를 FakeBackend 서버와 실기기 양쪽에서 통과한다.

**Blocked by:** 01 (계약 스위트)

**Status:** done

- [x] `observe()` 는 `device.dump.ui`(트리만), `observe({ pixels: true })` 만 `device.snapshot` 을 써 `Observation.atomic` 을 함께 준다(결정: 매 observe 마다 수 MB 스크린샷은 locator 자동 대기에 너무 비쌈)
- [x] `locate` 는 호출마다 새 dump 를 질의하고(마지막 observe 재사용은 자동 대기와 맞지 않음), `testId` 는 resource-id 전체/짧은 이름 모두에 매칭, perform 은 ref 를 기술자로 재매핑하고 같은 rect 가 2회 연속이면 actionable 로 본다
- [x] `perform` 은 ref 의 rect 중심을 `device.io.tap/longpress` 로, `type` 은 노드를 탭해 포커스한 뒤 `device.io.text` 로, `scroll` 은 `device.io.swipe` 로. ref 가 stale 이면 `not-found`
- [x] capability: `performAt`(pointer), `keyboard`(type/press/dismiss = BACK), `session`(open = launch, back, restart = terminate+launch, reset 은 `unsupported-action` 으로 범위 밖 명시)
- [x] 디바이스 레이어 오류(`-32000` 기기 없음, `-32002` 헬퍼 없음)가 `EngineError` 로 변환되고 메시지에 기기 id 가 남는다
- [x] 계약 스위트가 ScenarioBackend 기반 JSON-RPC 서버에서 통과하고, 실기기 opt-in(`SINCLAIR_TEST_USB=1`)으로 전화 앱(설정 앱은 시작 화면에 입력 필드가 없어 전화 앱으로 변경)에서 12/12 통과(비활성·secure 2 케이스는 시나리오에 없어 skip 표시)
- [x] `verify-device-layer` feature map 에 엔진 경유 레시피가 1개 추가된다

## Comments

- 2026-11-07: 완료. `createMobileEngine` + `rpcOverDispatcher`/`rpcOverHttp`, `ScenarioBackend` 페이크(로그인→홈 상태 기계, 좌표 히트, 포커스, 애니메이션), 고유 테스트 7개(pixels 요청 시에만 snapshot, 탭 좌표·type 순서, ref 재매핑, rect 안정화 대기와 기한 초과, scroll/press/keyboard/session 매핑, RPC 오류 변환). 실기기 SM-N981N 전화 앱 시나리오로 계약 스위트 통과.
- 실기기에서 드러나 고친 것: (1) 헬퍼가 빈 입력 필드의 힌트를 내용으로 쳐 setText 가 "검색wifi" 처럼 힌트 뒤에 덧붙이고 dump 의 value 에도 힌트가 들어가던 것 → `isShowingHintText` 로 제외. (2) 계약 스위트가 앱 기동 직후 조회해 런처를 보던 것 → `fresh()` 가 `session.restart` 뒤 전환 노드가 보일 때까지 대기, type 뒤 재조회도 기한 안 폴링. `ContractScenario` 필드를 `LocatorQuery` 로 일반화하고 `typeText` 추가(전화 번호 필드는 숫자만).
- 범위 밖·메모: 개인정보가 보이는 화면(통화 기록, 휴대전화 정보)은 시나리오·증거에서 제외. `session.open` 은 launch(상태 유지)이고 처음 상태가 필요하면 `restart`.
- 2026-11-07 리뷰 반영: (1) 그 밖의 RPC 실패를 `timeout` 으로 보고하던 것 → 새 코드 `device-error`(protocol 계약 테스트·spec 먼저). (2) 증거 JSON 의 기기 시리얼을 끝 4자리로 마스킹하고 통과/실패/skip 수를 `afterEach` 로 세어 기록. (3) `fresh()` 의 restart 실패 대체를 `unsupported-action` 일 때로 좁혀 기기 문제를 가리지 않음. (4) dump 마다 기술자 맵을 지우지 않고 덮어써 locate–perform 사이의 다른 dump 에도 재매핑 유지, 단일 호출자 전제를 spec 에 명시. (5) `rpcOverHttp` 30초 timeout, 모르는 키 이름은 `unsupported-action`, 스크롤 방향 표, longpress/swipe 헬퍼, `ScenarioBackend.setScreen`. (6) 테스트 추가: `-32002` → device-unavailable, 화면 전환 뒤 stale ref → not-found. (7) specs/0001 의 bounds 체이닝 fallback 은 미결로 spec 0002 와 티켓 03 에 넘김. `observe({pixels:true})` 가 앵커 검사용이라는 약속을 spec 에 기록. 받아들인 한계: Samsung 전화 앱 시나리오라 다른 기기는 시나리오를 바꿔야 함.
