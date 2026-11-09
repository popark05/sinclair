# 에이전트(agent.act·assert) 실기기 종단

QA 가 `agent.act('자연어 목표')` 와 `agent.assert('판정 문장')` 을 쓴 테스트 파일이 실기기에서 끝까지 돈다. 실제 모델(Claude, 기본 Sonnet 5.5)이 화면 트리를 보고 툴을 고르고, 러너가 결정적으로 실행한다.

## Sub-features

- `agent-pass` 목표 달성 + 판정: 설정 앱에서 "휴대전화 정보" 화면을 열고 assert 로 확인. 스텝 act/assert, modelCalls, usage(토큰), 소요 시간.
- `agent-secret` 비밀값: `secret('QA_SEARCH')` 를 설정 검색창에 입력. 값은 엔진에만 가고, 모델 요청 본문·리포트·이벤트·screen-tree 에 없다(검색창이 secure 가 아니어도 값 일치로 자리표시로 가린다).
- `agent-fail` 이룰 수 없는 목표: 턴 한도(12) 안에서 사유와 함께 실패(errorCode agent), 아티팩트(screenshot·screen-tree)가 남는다.
- `agent-skip` 키 없이 `SINCLAIR_AGENT_LIVE=1` 이면 분명한 오류, 키는 있는데 API 에 닿지 않으면(네트워크·사내망 CA) 건너뜀.

## How to get to it (user POV)

- `packages/runner/test/fixtures/agent-device.sinclair.ts` 같은 파일을 쓰고, runner-agent 로 돌리면 실행기는 환경변수(`ANTHROPIC_API_KEY`, `SINCLAIR_AGENT_*`)로 만들어진다.

## Driving it

Preconditions: Baseline + 화면 켜짐 상태 유지(잠금 없음), 한국어 UI 삼성 설정 앱.

- **실제 모델.** `adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_AGENT_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run packages/runner/test/agent.device.test.ts`(사내망은 `NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem`). 증거 `.scratch/agent-layer/evidence/08-agent-device-live-latest.json`.
- **배관만(모델 없이).** 같은 명령에서 `SINCLAIR_AGENT_LIVE`·키를 빼면 화면 글자를 읽는 대본 실행기로 돈다 — 디바이스·러너·안전망·Incident·비밀값 가림의 실기기 경로를 보지만 **실제 모델 증명이 아니다**. 증거 `…-scripted-latest.json`.
- 판정 기준: summary `{passed 2, failed 1}`, 셋째 테스트 errorCode `agent`·"턴 한도 12"·아티팩트 둘, `secret.*.valueFound` 가 모두 false 이고 `scanned` true.

## Gotchas

- 설정 첫 화면 맨 위에 기기 소유자 이름·삼성 계정 이메일 일부가 보인다. 실제 모델 실행이면 그 글자가 관찰로 모델에 간다(ledger·redaction 은 비밀값만 가린다). 증거에는 판정 근거 문구(화면 글자를 옮길 수 있음)를 싣지 않는다.
- 삼성 설정의 검색은 다른 패키지 화면으로 열린다 → `left-app` Incident 가 "모델에 알림" 으로 한 번 기록된다(실패 아님, 의도한 동작).
- 휴대전화 정보는 설정 목록 맨 아래라 스크롤 4번 안팎이 든다.
- 키보드 복구는 engine-mobile 이 `keyboard.shown` 을 아직 구현하지 않아 실기기에서는 꺼져 있다.
