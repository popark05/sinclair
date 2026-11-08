# 01: agent.act 골격과 닫힌 툴 스키마 — 대본 모델로 목표 한 줄이 화면 조작이 된다

**What to build:** 테스트 파일이 `agent.act('아이디 qa 로 로그인해줘')` 처럼 자연어 목표를 주면, 에이전트가 화면을 관찰하고 모델에게 닫힌 툴 집합(탭·입력·스크롤·뒤로·완료 등)으로만 행동을 고르게 해 엔진으로 실행하고, 목표를 이루거나 한도에 닿으면 끝낸다. 이 티켓의 모델은 **대본대로 답하는 가짜 모델**이라 네트워크 없이 결정적으로 돈다. 스텝은 `step.recorded(kind act, modelCalls)` 로 보고된다. 새 에이전트 패키지는 protocol 에만 기대고 러너가 그것을 쓴다(protocol ← agent ← runner).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 툴은 하나의 action spec 에서 만든다: 각 툴의 이름·인자 스키마·엔진 동작이 한 곳에 있고, 모델에 주는 스키마와 실행기가 같은 원천에서 나온다(어긋나면 계약 테스트가 실패). 닫힌 스키마라 모르는 툴·인자는 실행 전에 거부
- [x] `StepExecutor` 경계: 에이전트 루프는 "관찰 + 목표 + 지난 턴 → 다음 툴 호출" 을 실행기에 묻는다. 대본 실행기(가짜 모델)가 테스트용 기본 구현
- [x] 루프 한도: 턴 수·시간 상한(기본값과 이유 주석), 한도에 닿으면 act 실패(사유). 모델이 "완료" 를 고르면 성공
- [x] 관찰은 엔진 observe 의 secure redaction 을 거친 것만 모델에 간다(기존 redactSecure)
- [x] 러너 fixture `agent` 와 이벤트: act 하나가 스텝 하나, 안의 툴 실행은 instruction 에 요약, modelCalls 는 실제 묻은 횟수
- [x] 테스트: FakeEngine 로그인 시나리오에서 대본(아이디 입력 → 비밀번호 입력 → 로그인 탭 → 완료)으로 HOME 에 닿음, 닫힌 스키마 위반 거부, 턴 한도 초과 실패, 스텝 이벤트가 검증기를 통과

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 seam: (1) action spec → 툴 스키마·검사기·실행(툴 다섯), (2) `runAct` 루프(거부·엔진 오류를 다음 턴에 돌려주고 턴에 셈, 기본 20턴·120초), (3) 러너 fixture `agent.act` + 스텝 이벤트.
- 결정: 새 패키지 `@sinclair/agent`(protocol 에만 의존, runner 가 의존) — CLAUDE.md 구조·의존 방향에 반영. 스텝 instruction 에는 툴 이름과 ref 만(입력 글자 제외 — 비밀값 처리는 04). act 실패의 errorCode 는 `agent`(판정 실패 `assertion` 과 구분). 실행기가 시간 한도를 넘기면 기다리지 않고 실패.
- 테스트: 계약 3개(툴 다섯의 설명·실행, 스키마 모양, 검사기가 스키마 required 와 같은 판단 — 반복으로 검증), 루프 6개(관찰 렌더링·secure 값 미노출, 대본 로그인 → HOME·실행기 입력 검사, 스키마 위반 거부 후 진행, 엔진 오류 전달, 턴·시간 한도, 실행기 예외), 러너 3개(act 스텝 이벤트·검증기 통과·입력 글자 미기록, 실패 → failed Attempt·아티팩트·errorCode agent, 실행기 없음 → 설정 오류). 번들(`pnpm bundle`) 통과.
