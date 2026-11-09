# 08: 실기기 종단 — 실제 모델이 실기기에서 목표를 이루고 판정한다

**What to build:** `verify-runner` 스킬에 에이전트 feature 를 더한다: 실제 모델(Sonnet 5.5)로 실기기에서 `agent.act('설정 앱에서 휴대전화 정보 화면을 연다')` 같은 목표를 이루고 `agent.assert` 로 확인하는 샘플이 끝까지 돈다. 호출 수·토큰·안전망 개입·Incident 가 스텝과 증거에 남고, 비밀값 샘플은 값이 어디에도 남지 않는다.

**Blocked by:** 02 (실제 모델 실행기), 03 (판정 동사), 04 (비밀값), 05 (액션 전 안전망)

**Status:** done

- [x] 실기기 샘플: act 목표 + assert, 실제 모델, 성공. 증거에 스텝(act/assert), modelCalls, 토큰, 소요 시간(시리얼·경로 마스킹, API 키 없음)
- [x] 비밀값 샘플(예: 검색창에 secret 입력)에서 값이 증거·이벤트·요청 기록에 없음을 확인
- [x] 실패 경로: 이룰 수 없는 목표는 턴 한도 안에서 사유와 함께 실패, 아티팩트가 남음
- [x] 키·네트워크가 없을 때는 분명하게 건너뜀(opt-in)

## Comments

- 2026-11-09: `verify-runner` 에 에이전트 feature(`features/agent.md`), `packages/runner/test/agent.device.test.ts` + `fixtures/agent-device.sinclair.ts`(목표+판정 · 비밀값 검색 · 이룰 수 없는 목표). 실제 모델이면 요청 본문을 기록하는 fetch 를 주입해(`ClaudeExecutorOptions.fetch`) 비밀값이 본문에 없음을 확인, 실호출 전 `probeClaude`(countTokens)로 닿지 않으면 건너뜀, 키 없이 `SINCLAIR_AGENT_LIVE=1` 이면 분명한 오류.
- **SM-N981N(Android 13) 배관 확인(대본 실행기, 모델 아님)**: passed 2·failed 1(턴 한도 12, 아티팩트 둘), 휴대전화 정보까지 스크롤 4번·탭, 검색창 비밀값 입력 뒤 관찰에 자리표시만(판정이 그걸로 통과), 리포트·실행기 요청·screen-tree 에 값 없음, 삼성 검색은 다른 패키지라 left-app "모델에 알림" 1회(실패 아님). 증거 `.scratch/agent-layer/evidence/08-agent-device-scripted-latest.json`.
- **남은 일(사람)**: 이 머신에 Claude API 키가 없어 실제 모델 실행을 못 했다. 키를 넣고 `adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_AGENT_LIVE=1 ANTHROPIC_API_KEY=… NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem npx vitest run packages/runner/test/agent.device.test.ts` → live 증거가 남으면 첫 기준을 닫는다. 같은 키로 `SINCLAIR_AGENT_LIVE=1 npx vitest run packages/agent/test/claude-live.test.ts` 도(Ledger 추정 vs countTokens, 판정 동사).
- 개인정보 주의: 설정 첫 화면에 기기 소유자 이름·계정 이메일 일부가 보여 실제 모델 실행이면 관찰로 모델에 간다(비밀값만 가린다). 증거에는 판정 근거 문구를 싣지 않는다. 화면 개인정보 가림은 별도 티켓 후보.
- 2026-11-09 **실제 모델(claude-sonnet-5-5) 실기기 종단 통과**(SM-N981N, Android 13, 71초): passed 2·failed 1. ① 휴대전화 정보: 스크롤 3·탭·안전망 개입 1(실행 직전 대상 사라짐 → 다시 물음)·done 6턴 + assert 참. ② 비밀값 검색: 검색 열기·안전망 1·type·done 거부 1(Incident 알림 뒤)·done 5턴 + assert 참, left-app 알림 1. ③ 이룰 수 없는 목표: 턴 한도 12, 아티팩트 둘. 모델 호출 25, 프롬프트 캐시 적중(cacheRead 6760 — 02 리뷰가 남긴 "캐시가 맞는지" 를 실측으로 확인). 비밀값 검사: 리포트·실제 요청 본문 25건·screen-tree 모두 값 없음. 증거 `.scratch/agent-layer/evidence/08-agent-device-live-latest.json`(키·시리얼·이름·이메일 없음 확인).
- 같은 키로 `claude-live.test.ts` 3개 통과: FakeEngine 로그인 4턴, 판정 동사(참·거짓·추출·secure 추출은 not-found), Ledger 추정 vs countTokens — **처음엔 한글을 적게 셌다**(860자 실제 987 토큰 vs 추정 785, 화면 트리 2590자 실제 1498 vs 1384). 추정을 비ASCII 글자당 1.35·ASCII 글자 2.5자당 1·숫자·기호 1.8자당 1(×1.1)로 올려 둘 다 실제 이상(1026/987, 1545/1498). 화면 생략 표시 몫도 문구 자체로 세게 고쳤다(고정 45 는 한글 단가가 오르자 예산을 2 넘었다).
- 이 머신에는 사내망 CA 파일(`~/.certs/all-system-certs.pem`)이 없지만 API 에 직접 닿았다.
