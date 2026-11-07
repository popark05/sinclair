# 01: 엔진 계약 테스트 키트와 FakeEngine

**What to build:** 어떤 엔진 구현이든 돌려서 "러너가 기대하는 대로 동작하는가" 를 확인할 수 있는 재사용 계약 스위트. `Engine` SPI 의 의미를 protocol 에 고정하고, 메모리 트리로 동작하는 `FakeEngine` 이 그 스위트를 통과한다. 이후 러너 티켓은 전부 이 FakeEngine 위에서 테스트한다.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] protocol 에 엔진 오류 코드(`not-found`, `ambiguous`, `not-actionable`, `secure-read`, `unsupported-action`, `timeout`, `engine-closed` 등)와 `EngineError` 타입이 정의되고 계약 테스트가 목록을 고정한다
- [x] `locate` 의 매칭 규칙이 문서와 계약 테스트로 고정된다: role 은 정확 일치, name/text 는 문자열이면 대소문자 무시 부분 일치·정규식이면 정규식, testId/placeholder 는 정확 일치, `within` 은 조상 ref 아래로 제한, `nth` 는 문서 순서, `secure` 노드의 text/value 는 돌려주지 않는다
- [x] `perform` 의 액션별 전제가 고정된다: `type` 은 편집 가능 노드, `check/select` 는 해당 역할, 비활성(`disabled`) 노드는 `not-actionable`
- [x] `engineContractSuite(name, makeEngine)` 가 vitest `describe` 로 제공되어 다른 패키지 테스트에서 import 해 쓸 수 있다(관찰 → 위치 → 수행 → 재관찰의 사용자 경로로만 검증)
- [x] `FakeEngine`(메모리 `SemanticNode` 트리, 액션이 트리를 바꿈: tap 은 `onTap` 핸들러, type 은 value 변경, 화면 전환 시뮬레이션)이 스위트를 통과하고 러너 테스트가 쓸 수 있게 export 된다
- [x] GLOSSARY 에 "엔진", "locator", "판정", "capability" 정의가 들어간다

## Comments

- 2026-11-07: 완료. protocol `engine.ts` 에 `ENGINE_ERROR_CODES`/`EngineError`, 매칭 규칙의 단일 소스 `locateInTree`/`matchesQuery`(계약 테스트 6개). `@sinclair/protocol/testing` 서브패스에 `engineContractSuite`(11 케이스, observe→locate→perform→재관찰의 사용자 경로만), `FakeEngine`(메모리 트리, onTap 화면 전환, appearAfterMs 지연, type/check/select 가 트리를 바꿈), 기준 화면 `loginScenario`/`LOGIN_SCENARIO`. 스위트는 고의 손상 2건(secure 내용 누출, 편집 불가 노드 type 허용)을 잡는 것을 확인. `packages/runner/test` 에서 서브패스 import 로 스위트가 도는 것을 스모크 테스트로 고정. GLOSSARY 에 엔진·locator·판정·capability.
- 결정: `perform` 의 액션별 전제는 FakeEngine 이 기준이며 `type` 은 textbox/searchbox/combobox, `check` 는 checkbox/switch/radio, `select` 는 combobox 만. 실제 엔진(02)이 이를 따르지 못하면 계약 스위트가 알려준다. 스위트의 시나리오(`ContractScenario`)는 엔진마다 다른 시작 화면을 허용하도록 매개변수화했다(02 는 설정 앱 화면으로).
