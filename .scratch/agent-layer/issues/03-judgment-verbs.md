# 03: 판정 동사 — agent.assert·waitFor·extract

**What to build:** 테스트가 `agent.assert('로그인되어 홈 화면이다')`, `agent.waitFor('결제 완료 문구가 뜬다')`, `agent.extract('장바구니 합계', 숫자)` 로 화면을 판정·대기·추출한다. 판정은 화면을 바꾸지 않고(툴 없음), 모델은 닫힌 구조화 출력(참/거짓과 근거, 또는 지정한 타입의 값)으로만 답한다. assert 실패는 일반 판정 실패와 같이 실패한 Attempt 가 되고 아티팩트를 남긴다.

**Blocked by:** 01 (agent.act 골격)

**Status:** done

- [x] 세 동사 모두 화면을 바꾸지 않는다: 엔진 조작 툴을 주지 않고 관찰만
- [x] assert: `{ pass, reason }` 구조화 출력, 거짓이면 판정 실패(근거가 오류 메시지에). waitFor: 기한 안에서 관찰을 다시 보며 참이 될 때까지(기본 기한과 간격, 이유 주석). extract: 요청한 타입(문자열·숫자·불리언·간단한 객체)으로만, 타입이 안 맞으면 실패
- [x] secure 노드의 내용을 추출하려 하면 거부(기존 secure-read 규칙과 같게)
- [x] 스텝 이벤트 kind 는 assert/waitFor/extract, modelCalls 기록
- [x] 테스트: 대본 모델로 참·거짓·타입 불일치·기한 초과·secure 추출 거부, 판정 실패가 runner 의 failed Attempt 와 아티팩트로 이어짐

## Comments

- 2026-11-08 구현(seam 3개 승인): (1) `packages/agent` `judgeAssert`·`judgeWaitFor`·`judgeExtract` + 실행기 선택 메서드 `judge`(닫힌 답 스키마, 에이전트가 다시 검사) (2) 러너 fixture `agent.assert/waitFor/extract`(extract 반환 타입 추론), 스텝 kind·modelCalls·usage (3) Claude `judge`: 구조화 출력 `output_config.format: json_schema`, 툴 없음, 판정용 고정 system, 거절·JSON 아님은 invalid.
- 기본값: assert·extract 한 번의 기한 60초, waitFor 30초·간격 1초(관찰은 싸고 모델은 화면이 바뀔 때만 부른다 — 같은 트리면 재호출 없음).
- secure: 관찰에는 원래 값이 없고, 모델이 secure 노드를 근거(sourceRefs)로 대면 `EngineError('secure-read')` — 러너의 기존 secure 읽기 규칙과 같은 코드.
- 오류 분류: 거짓·기한 초과·못 찾음 → `assertion`(failed + 아티팩트, 근거가 오류 메시지), 계약 위반 답·모델 호출 실패 → `agent`, judge 없음 → `agent-config`(blocked), secure → `secure-read`. 스텝 instruction 에 추출값은 남기지 않는다(화면의 개인정보일 수 있다).
- opt-in 실호출(`claude-live.test.ts`)에 판정 동사 케이스를 더했다. 이 머신에는 키가 없어 돌리지 못함(02 와 같다).
- 리뷰 반영(should-fix 5 + nit): (1) extract 성공 스텝에 근거 문구 대신 근거 ref 만(`→ 추출함 (@h1)`): 실제 모델은 근거에 값을 쓴다 — 테스트 대본도 근거에 값을 넣고 스텝 전체에 값이 없음을 확인. (2) secure 거부 등 판정이 던져도 그때까지의 modelCalls·usage 를 실패 스텝에(`recordProgress`/`actProgressOf` 공용). (3) assert·extract 의 기한 초과는 화면 판정이 아니라 모델 문제라 invalid(→ agent); timeout(→ assertion)은 waitFor 만. (4) waitFor 재호출 판단은 트리 + 위치 + (pixels 실행기면) 이미지 해시. (5) 판정이 조작하지 않음을 performed·typed·pressed 까지 확인. nit: 간격 타이머 정리, 기한이 지났으면 judge 를 부르지 않음, extract 타입 객체의 빈 키·`__proto__`·잘못된 스칼라 거부, test.ts import 순서.
- 남긴 것: 판정 기한을 runTests·환경변수로 바꾸는 설정은 없음(기본 60초/30초, waitFor 는 호출별 옵션). 추출값이 근거 노드의 글자에 실제로 있는지 대조하지 않음(환각 값 + 실제 ref 는 통과) — 필요하면 05(안전망)에서.
