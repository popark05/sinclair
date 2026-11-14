# 05: 에이전트 세션 — 목표 실행, 턴 스트리밍, 판정 추가

**What to build:** 가운데 세션 탭에서 목표를 넣어 작업 프로세스가 `runAct`(실제 모델, 녹화 캐시)를 돌리고, 턴(툴·대상·안전망·Incident·화면 변화)을 스트리밍하며 중지할 수 있게 한다. 끝나면 assert 문장을 더해 `judgeAssert` 로 판정한다.

**Blocked by:** 03

**Status:** done

- [x] 턴 이벤트를 runAct 에 훅으로(실행기 요청·결과), 키·사내망 CA 설정 안내(키 없으면 세션 비활성 + 이유)
- [x] 중지(AbortSignal), 세션 기록(목표·턴·판정·녹화 항목)
- [x] 테스트: 대본 실행기·FakeEngine 으로 턴 스트림·중지·판정

## Comments

- 2026-11-14 구현(실기 확인은 대기 — 아래). agent `runAct` 에 `onTurn(turn, index)`(턴이 기록되는 순간, 거부·오류 포함, 보는 쪽 오류는 무시)과 `signal`(바깥 중지 → 사유 '중지됨', 시간 한도와 같은 길) 추가.
- Studio 작업 프로세스 `sessions.ts`: 세션마다 고른 기기의 엔진(engine-mobile, 데몬 또는 직접 RPC)에서 runAct, 턴은 `TurnView`(툴·대상 ref·결과·안전망 — 입력 글자는 싣지 않음)로, 끝은 `SessionResult`(성공·요약·사유·턴·모델 호출·토큰·녹화)로 이벤트 푸시(작업 프로세스 → 메인 → 렌더러 `studio:event`). 중지, 지금 화면 판정(`judgeAssert`). 에이전트는 `agentFromEnv`(SINCLAIR_AGENT_*·ANTHROPIC_*), 준비 상태는 `probeClaude`(토큰 세기, 과금 없음 — 준비되면 기억).
- IPC: agent-status·session-start(목표 1~2000자)·session-stop·session-assert, `{type:'event'}` 메시지 검사.
- `SessionPanel`(가운데 세션 탭): 목표(TextArea) → 실행(기기·에이전트 준비돼야, 아니면 이유), 실행 중 중지, 턴 타임라인(n. 툴 대상 — 안전망·거부·오류), 결과(성공·실패·턴·모델·토큰), 판정 문장 → 참·거짓과 근거 목록. 세션 기록은 `onRecord` 로(06 내보내기).
- 실기 확인: 빌드된 작업 프로세스를 메인과 같은 방식으로 띄워 실제 모델 세션을 도는 스크립트 `.e2e/studio/session-live.ts` 를 준비했으나, 돌리는 순간 폰이 USB 에서 빠져 있어(시스템 USB 목록에도 없음) 아직 못 돌렸다. 다시 연결하면 실행.
- 2026-11-14 실기 확인(폰 재연결 뒤): `.e2e/studio/session-live.ts` — 빌드된 작업 프로세스를 메인과 같은 `createWorkerHost` 로 띄워 데몬 경유 SM-N981N·실제 모델(claude-sonnet-5-5). agent-status ready, 연결 daemon. YouTube 검색 세션: 턴 이벤트 5개(tap 검색 → type → submit → scroll(안전망: 사라짐) → done), done ok·13초·모델 5회·입력 6.9k 토큰, 녹화 3액션(tap 검색·type·submit). 이어서 session-assert 참(검색 결과 목록이 열려 있음).
