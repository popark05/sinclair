# runner: locator/expect 와 엔진 계약

CLAUDE.md 작업 로그의 다음 티켓 2번. 근거: `specs/0001-architecture.md` 엔진·러너 절, `docs/adr/0001-test-script-format.md`(e2e 방식), `packages/protocol/src/engine.ts`.

범위: 러너의 **결정적 계층**만 다룬다. `screen` locator, `expect` 판정, `test()` API 와 최소 실행기, 그리고 그 아래의 엔진 계약(`Engine` SPI)과 모바일 구현(`packages/engine-mobile`). 에이전트(`agent.act/assert`)와 녹화·재생 캐시는 별도 intent 로 미룬다.

원칙:
- 계약(엔진 SPI, 오류 코드, 매칭 규칙)은 `packages/protocol` 에 먼저 고정하고 계약 테스트를 쓴다. 어떤 엔진 구현이든 같은 계약 스위트를 통과해야 한다.
- 의존 방향 `protocol ← device-layer ← engine-mobile ← runner`. 러너는 디바이스 레이어를 모른다.
- `reference/e2e` 는 설계(세 동사 분리, strict 모드, 닫힌 스키마, secure 읽기 거부)만 참고하고 코드를 복사하지 않는다. mobilewright 는 locator 의 모바일 세부(testId 다중 매칭, bounds 체이닝, 2회 연속 동일 bounds)만.
- 모든 티켓은 페이크(FakeEngine 또는 FakeBackend 서버)와 실기기(opt-in) 양쪽 테스트를 가진다.

티켓은 `issues/` 에 있다. 의존 순서: 01 → 02, 03 → 04 → 05(02·03·04 뒤).
