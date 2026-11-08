# 03: 판정 동사 — agent.assert·waitFor·extract

**What to build:** 테스트가 `agent.assert('로그인되어 홈 화면이다')`, `agent.waitFor('결제 완료 문구가 뜬다')`, `agent.extract('장바구니 합계', 숫자)` 로 화면을 판정·대기·추출한다. 판정은 화면을 바꾸지 않고(툴 없음), 모델은 닫힌 구조화 출력(참/거짓과 근거, 또는 지정한 타입의 값)으로만 답한다. assert 실패는 일반 판정 실패와 같이 실패한 Attempt 가 되고 아티팩트를 남긴다.

**Blocked by:** 01 (agent.act 골격)

**Status:** ready-for-agent

- [ ] 세 동사 모두 화면을 바꾸지 않는다: 엔진 조작 툴을 주지 않고 관찰만
- [ ] assert: `{ pass, reason }` 구조화 출력, 거짓이면 판정 실패(근거가 오류 메시지에). waitFor: 기한 안에서 관찰을 다시 보며 참이 될 때까지(기본 기한과 간격, 이유 주석). extract: 요청한 타입(문자열·숫자·불리언·간단한 객체)으로만, 타입이 안 맞으면 실패
- [ ] secure 노드의 내용을 추출하려 하면 거부(기존 secure-read 규칙과 같게)
- [ ] 스텝 이벤트 kind 는 assert/waitFor/extract, modelCalls 기록
- [ ] 테스트: 대본 모델로 참·거짓·타입 불일치·기한 초과·secure 추출 거부, 판정 실패가 runner 의 failed Attempt 와 아티팩트로 이어짐
