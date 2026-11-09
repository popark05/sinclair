# 02: Cycle 매트릭스 히트맵 + Verdict — 한 Cycle 의 테스트 × 타깃 결과를 한눈에

**What to build:** Cycle 화면이 테스트 × 타깃 매트릭스를 셀 색(verified·passed-flaky·failed·blocked·skipped·대기)으로, Cycle Verdict 와 Run 행(상태·기기·노드·대체·버려짐)을 보여 주고, 진행 중이면 주기적으로 새로 고친다.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 매트릭스(행 = 테스트, 열 = 타깃), 셀 색·범례, 경고(warnings) 표시
- [ ] Run 행: state, deviceId, agentId, replaces/replacedBy/abandonedAt, retriesUsed
- [ ] 끝나지 않은 Cycle 은 자동 새로 고침(간격 이유 주석), 끝나면 멈춤
- [ ] 테스트: 가짜 API 로 셀 색·대체 Run·자동 새로 고침 멈춤
