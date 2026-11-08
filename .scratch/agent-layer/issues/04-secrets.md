# 04: 비밀값 — 모델은 자리표시만 보고, 러너가 입력할 때 바꾼다

**What to build:** 테스트가 `agent.act(\`아이디 qa, 비밀번호 ${secret('QA_PASSWORD')} 로 로그인\`)` 처럼 비밀값을 넘기면, 모델은 `{{secret:QA_PASSWORD}}` 같은 자리표시만 보고 그것을 입력하라는 툴 호출을 낸다. 실제 값은 러너가 엔진에 입력하는 순간에만 바꿔 넣는다. 비밀값은 프롬프트·모델 응답·스텝 이벤트·아티팩트·로그 어디에도 남지 않는다(intent 의 제약 "모델이 비밀값을 보지 못해야 한다").

**Blocked by:** 01 (agent.act 골격)

**Status:** done

- [x] `secret(이름)` 은 실행 환경(환경변수 또는 비밀 저장소 어댑터)에서 값을 찾고, 없으면 분명한 설정 오류
- [x] 모델에 가는 모든 텍스트(목표·관찰·지난 턴)에는 자리표시만. 입력 툴의 인자에 자리표시가 오면 러너가 치환해 엔진에 넘긴다. 자리표시를 다른 툴(탭 등)·다른 필드에 쓰면 거부
- [x] 입력한 필드는 화면 관찰에서 secure 로 다뤄지지 않더라도 그 값을 관찰·요약·아티팩트에서 지운다(값 일치로 가림)
- [x] 스텝 instruction·이벤트·스크린샷 아티팩트 메타·로그에 값이 없음을 테스트(대본 모델 + 02 가 있으면 가짜 HTTP 로 요청 본문까지)

## Comments

- 2026-11-08 구현(seam 3개 승인): (1) `packages/agent` `SecretBox`(reveal·redact·mentions) + runAct·판정 동사 `secrets` 옵션 — type 의 text 만 치환, 다른 툴·필드·모르는 이름은 rejected, 관찰·오류 문구 값 일치 가림, 비밀값이 있으면 픽셀 끔 (2) 러너 fixture `secret(이름)`·`RunOptions.secrets`(기본 `SINCLAIR_SECRET_<이름>`), 없으면 blocked `secret-missing`, screen `type` 도 치환, 이벤트·TestResult(스텝·오류·경고)·screen-tree 를 run 의 모든 비밀값으로 가림 (3) 실제 Claude 실행기 + 가짜 HTTP 로 secure 가 아닌 비밀번호 칸 시나리오 — 요청 본문에 값 없음, 엔진엔 실제 값.
- 테스트가 잡은 누출: TestResult.steps 가 가리기 전 스텝 객체를 들고 있었다(이벤트만 가렸음) — 스텝을 만들 때 가린다.
- 비밀값 저장소는 동기 `get(name)` 어댑터(사내 저장소는 미리 읽어 넣는다). runner-agent 도움말에 `SINCLAIR_SECRET_<이름>`.
- 남긴 것: 스크린샷 픽셀은 가리지 않는다(아티팩트 디렉터리는 비밀로 다룬다). 아주 짧은 값(예: 1자)은 가림이 다른 글자까지 바꾼다 — 경고는 하지 않음. 테스트 코드가 throw 하는 오류 문구에 값을 직접 넣는 경우는 값 일치로 가려진다.
