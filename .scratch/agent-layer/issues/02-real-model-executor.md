# 02: 실제 모델 실행기 — Claude API 가 StepExecutor 뒤에서 툴을 고른다

**What to build:** 같은 `agent.act` 가 실제 모델(Claude, 기본 Sonnet 5.5, 설정으로 Opus 5.5·Haiku 5.5)로 돈다. API 키는 환경변수로만 받고 로그·이벤트·증거 어디에도 남기지 않는다. 사내망(SSL 인터셉션)에서도 호출된다. 스텝에는 호출 수와 토큰 사용량이 남아 Console 이 비용을 볼 수 있다.

**Blocked by:** 01 (agent.act 골격)

**Status:** done

- [x] 모델·기한·재시도(일시 오류만)·최대 토큰은 설정(환경변수와 러너 옵션), 기본 Sonnet 5.5. 키가 없으면 act 는 분명한 설정 오류로 실패(테스트를 엉뚱하게 실패시키지 않음)
- [x] 01 의 action spec 에서 만든 툴 스키마를 그대로 모델의 tool 정의로 쓴다(따로 적지 않는다)
- [x] 스텝 이벤트에 토큰 사용량(입력·출력, 캐시 적중이 있으면 그것도). 이벤트 스키마를 바꾸면 protocol 계약 테스트를 먼저 갱신
- [x] 개인정보·비밀: 가짜 HTTP 서버로 요청 본문을 가로채 secure 값·API 키가 없음을 확인. 화면 이미지(픽셀)를 보낼지는 설정(기본: 트리만)
- [x] 사내망: `NODE_EXTRA_CA_CERTS` 로 동작함을 문서화하고 확인
- [x] 키가 있을 때만 도는 opt-in 테스트로 FakeEngine 로그인 시나리오를 실제 모델이 끝냄(호출 수·토큰 기록)

## Comments

- 2026-11-08 구현(seam 4개 승인): protocol `step.recorded.usage`(닫힌 `StepUsage`, 계약 테스트 먼저) → 루프 `StepReply { call?, text?, usage? }`·`ModelCallError`(거절 등이 쓴 토큰도 합산)·`ModelConfigError`(루프가 그대로 던짐)·`StepExecutor.pixels` → `createClaudeExecutor`(가짜 HTTP 서버로 본문 검사) → 러너 `usage` 스텝·`agent-config` blocked → control-plane 스텝 투영 `usage` → runner-agent `agentFromEnv`(시작 때 검증, 키 없으면 act 테스트만 blocked).
- 요청 모양: 고정 system(cache_control) + action spec 툴 그대로 + `strict: true`, `tool_choice: auto`·`disable_parallel_tool_use`(Sonnet 5.5 는 강제 tool_choice 400), `fallbacks: "default"` + 베타 `server-side-fallback-2026-07-01`(Haiku 5.5 처럼 fallback 없는 모델은 요청 모델만으로 돈다), effort medium, max_tokens 8192, 요청 기한 60초, 재시도 2(SDK: 연결·408·409·429·5xx 만).
- 개인정보: secure 값·API 키는 본문에 없음(키는 SDK 1.x 가 `Authorization: Bearer` 헤더로). 지난 턴의 `type` 글자는 `<입력함 N자>` 로 가려 모델에 되돌려 보내지 않는다. 오류 문구에 응답 본문·키를 싣지 않는다.
- 환경변수 이름: runner-agent 의 기존 `SINCLAIR_AGENT_TIMEOUT`(locator)·`SINCLAIR_AGENT_RETRIES`(테스트 재시도)와 겹치지 않게 모델 설정은 `SINCLAIR_AGENT_MODEL_*`, act 한도는 `SINCLAIR_AGENT_ACT_*`. 도움말(run·daemon)에 표로.
- 이름: 에이전트 패키지의 설정 오류는 `ModelConfigError`(runner-agent 의 `AgentConfigError` 는 CLI 설정 오류라 따로).
- 사내망: openssl 자체 CA HTTPS 가짜 API 로 CA 없이 실패(사유에 NODE_EXTRA_CA_CERTS 안내), CA 주면 성공(`claude-ca.test.ts`, 자식 Node).
- opt-in 실호출 `claude-live.test.ts`: 키 + `SINCLAIR_AGENT_LIVE=1` 일 때만(키만 있으면 과금되지 않게). **이 머신에는 키가 없어 실제 모델 호출은 돌리지 못함** — 키가 있는 환경에서 `SINCLAIR_AGENT_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run packages/agent/test/claude-live.test.ts` 로 확인 필요(호출 수·토큰을 한 줄 JSON 으로 출력).
- 남긴 것: 스트리밍 안 씀(턴 출력이 작다). fallback 이 돌았는지(`usage.iterations`) 는 기록하지 않음.
