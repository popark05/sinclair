# 05: 에이전트 세션 — 목표 실행, 턴 스트리밍, 판정 추가

**What to build:** 가운데 세션 탭에서 목표를 넣어 작업 프로세스가 `runAct`(실제 모델, 녹화 캐시)를 돌리고, 턴(툴·대상·안전망·Incident·화면 변화)을 스트리밍하며 중지할 수 있게 한다. 끝나면 assert 문장을 더해 `judgeAssert` 로 판정한다.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 턴 이벤트를 runAct 에 훅으로(실행기 요청·결과), 키·사내망 CA 설정 안내(키 없으면 세션 비활성 + 이유)
- [ ] 중지(AbortSignal), 세션 기록(목표·턴·판정·녹화 항목)
- [ ] 테스트: 대본 실행기·FakeEngine 으로 턴 스트림·중지·판정
