# 01: Reporter 훅과 이벤트 스키마 런타임 검증

**What to build:** 러너가 테스트를 돌리는 동안 각 `RunEvent` 를 발생 즉시 `Reporter` 에 넘겨, 리포트 배열이 끝날 때까지 기다리지 않고 외부(Ingest)로 흘려보낼 수 있다. 같은 이벤트 모양을 Ingest 쪽에서도 검증할 수 있도록 protocol 에 닫힌 런타임 검증기(`parseRunEvent` 류)를 두고, 러너의 기본 Reporter 와 Ingest 가 같은 검증을 쓴다. 리뷰에서 미룬 `run.started` 의 `cycleId`/`deviceId` "모를 때 `''`" 문제를 protocol 계약으로 결정한다(선택 필드로 바꾸거나 필수로 올려 러너 옵션을 필수화).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] protocol: `RunEvent` 런타임 검증기(unknown → RunEvent | 오류 목록). 닫힌 스키마: 모르는 `type`, 빠진 필수 필드, 잘못된 `schema` 버전, 상수 목록 밖의 `result`/`kind`/`state` 를 거부한다. 계약 테스트가 먼저 바뀐다
- [x] protocol: `run.started.cycleId/deviceId` 의 필수 여부 결정과 계약 테스트 반영. 러너는 `''` 로 채우지 않는다
- [x] runner: `Reporter` 인터페이스(이벤트 1건 수신, run 종료 시 flush)와 `runTests` 옵션. 기본 Reporter 는 지금의 `events[]` 와 동일한 결과를 낸다(기존 러너 테스트 그대로 통과)
- [x] Reporter 가 던지거나 느려도 테스트 실행 자체는 멈추지 않고, 오류는 `TestResult.warnings` 또는 리포트 수준 경고로 남는다
- [x] FakeEngine 테스트: 이벤트가 발생 순서대로 Reporter 에 도착하고, 모두 검증기를 통과한다

## Comments

- 2026-11-07: 완료. protocol `parseRunEvent(input): { ok, event } | { ok:false, errors[] }` (`event-schema.ts`): 닫힌 스키마(모르는 type·키 거부, 필수 필드, `schema` 버전, 상수 밖의 result/kind/state/cache/artifact kind, `at` ISO 8601), 오류는 모아서 돌려준다. 상수 `STEP_KINDS`/`ARTIFACT_KINDS`/`RUN_FINISHED_STATES` 를 events.ts 로 올려 타입과 검증기가 같은 출처를 쓴다. 계약 테스트 20개 + 기존 contract.test 1개.
- 결정: `run.started.cycleId`/`deviceId` 는 선택 필드(로컬·Studio 실행에는 Cycle 이 없다). `targetId` 는 필수(러너는 엔진 이름으로 채움). 러너는 모르는 값을 `''` 로 채우지 않고 생략한다.
- runner: `Reporter { onEvent(event), flush?() }`, `RunOptions.reporter`, `reporterFlushTimeoutMs`(기본 10초), `RunReport.warnings`. 러너는 모든 이벤트를 `parseRunEvent` 로 검증한 뒤(실패는 경고) `events[]` 에 쌓고 Reporter 에 넘긴다. onEvent 는 기다리지 않고(테스트 실행을 막지 않음) 보류 promise 를 모아 run 끝에 flush 와 함께 기한 안에 기다린다. onEvent/flush 실패와 flush 기한 초과는 `warnings` 로. FakeEngine 테스트 4개(순서·검증·flush 1회, 실패 격리, flush 기한, cycleId 생략).
