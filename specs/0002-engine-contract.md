# 0002. 엔진 계약 (Engine SPI)

- 상태: 승인
- 관련: specs/0001-architecture.md 엔진·러너 절, `packages/protocol/src/engine.ts`, 계약 스위트 `@sinclair/protocol/testing`

러너와 플랫폼 구현(engine-mobile, 향후 web) 사이의 계약. 타입은 `engine.ts`, 동작은 계약 스위트가 고정한다. 어떤 엔진이든 스위트를 통과해야 러너가 쓴다.

## 세 동사

- `observe()`: 현재 화면의 `SemanticNode` 트리. secure 노드의 `text/value` 는 뺀다(`redactTree`). `location` 은 선택. `observe({ pixels: true })` 는 스크린샷을 함께 주며 `atomic` 이 true 일 때만 트리와 같은 순간이다. 녹화 캐시의 앵커 검사(ADR 0003)는 이 호출을 쓴다.
- `locate(query)`: 즉시 1회 조회. 재시도·strict 판정은 러너 몫. 결과는 `children` 없는 노드 목록이며 secure 내용은 뺀다.
- `perform(ref, action, arg?)`: 직전 observe/locate 의 ref 에 액션. 엔진은 ref 가 가리키던 노드를 기술자(role/testId/name/text/placeholder)로 현재 화면에서 다시 찾는다(dump 마다 ref 번호가 바뀔 수 있으므로). 같은 기술자가 여럿이면 문서 순서 첫 노드다. 못 찾으면 `not-found`. 모바일 엔진은 좌표 액션 전에 트리를 최소 두 번 더 읽어(rect 안정화 확인) 실기기에서 호출당 수백 ms 가 든다. 같은 엔진은 한 번에 한 호출자만 쓴다(locate 와 perform 사이에 다른 호출자의 locate 가 끼면 ref 가 다른 노드를 가리킬 수 있다).

## locate 매칭 규칙 (`locateInTree`, 단일 소스)

| 필드 | 규칙 |
| --- | --- |
| `role` | 정확 일치 |
| `name`, `text` | 문자열: 대소문자 무시 부분 일치. `exact: true` 면 대소문자 구분 정확 일치. 정규식: 정규식(g/y 플래그는 무시) |
| `testId` | 정확 일치. Android resource-id 는 전체(`com.app:id/x`)와 짧은 이름(`x`) 모두 허용 |
| `placeholder` | 정확 일치 |
| `within` | 그 ref 의 자손(자기 자신 제외)으로 제한. 자손에서 못 찾으면 scope 의 rect 안에 완전히 놓인 노드로 다시 찾는다(bounds 체이닝 fallback). scope 가 없으면 빈 결과 |
| `nth` | within 적용 뒤 결과에서 0부터 세는 문서(DFS) 순서. 범위 밖이면 빈 결과 |

기본이 부분 일치인 이유: 모바일 접근성 이름은 "로그인 버튼" 처럼 꾸밈말이 붙는 경우가 많다. strict 모드에서 `ambiguous` 가 나면 `exact` 나 `testId` 로 좁힌다.

## perform 전제

| 액션 | 전제 | 어기면 |
| --- | --- | --- |
| `tap`, `double_tap`, `long_press` | 노드가 보이고 `disabled` 가 아님 | `not-actionable` |
| `type` | 편집 가능 역할(textbox, searchbox, combobox) | `not-actionable` |
| `check` | checkbox, switch, radio | `not-actionable` |
| `select` | combobox | `not-actionable` |
| 모든 액션 | `engine.actions` 에 있음 | `unsupported-action` |

## 오류 코드

`not-found`, `ambiguous`, `not-actionable`, `secure-read`, `unsupported-action`, `timeout`, `engine-closed`, `device-unavailable`, `device-error`(그 밖의 디바이스 레이어 실패). 엔진이 내는 것과 러너가 내는 것의 구분은 `engine.ts` 의 주석에 있다.

## capability

구현한 선택 메서드로 결정(`capabilitiesOf`): `performAt` → pointer, `keyboard` → keyboard, `session` → session. 광고한 capability 는 호출이 되어야 한다.

## 계약 스위트

`engineContractSuite(name, { makeEngine, scenario, navTimeoutMs? })`. `scenario` 는 엔진의 시작 화면에 대한 기대를 `LocatorQuery` 로 적은 것(전환 노드와 전환 뒤 질의, 입력 필드와 그 필드가 받는 글자, 비활성·secure·편집 불가 노드)이라 FakeEngine 은 로그인 화면으로, engine-mobile 은 실기기 앱 화면(Samsung 전화 앱: `digits` 입력 필드, 검색 버튼 → `search_src_text`)으로 만족시킨다. 비활성·secure 노드가 없는 시나리오는 그 검사를 `it.skip` 으로 드러낸다. 스위트는 사용자 경로(observe → locate → perform → 재관찰)만 쓴다.

## 스위트 자체의 검증 (실패 가능성)

스위트가 아무것도 못 잡는 동어반복이 아님을 확인하는 절차. FakeEngine 을 아래처럼 일부러 망가뜨리면 해당 케이스가 실패해야 한다(2026-11-07 확인).

| 손상 (`packages/protocol/src/testing/fake-engine.ts`) | 실패해야 하는 케이스 |
| --- | --- |
| `locate` 가 결과에 `value: 'leak'` 를 덧붙임 | "secure 노드는 … text/value 를 주지 않는다", "type 뒤 재조회하면 value 에 글자가 들어 있다" |
| `type` 의 편집 가능 역할 검사를 제거 | "편집할 수 없는 노드에 type 하면 not-actionable" |
| `actions` 에서 뺀 액션을 그대로 수행 | "actions 에 없는 액션은 unsupported-action" |

```bash
npx vitest run packages/protocol/test/fake-engine.contract.test.ts
```
