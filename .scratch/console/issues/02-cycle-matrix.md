# 02: Cycle 매트릭스 히트맵 + Verdict — 한 Cycle 의 테스트 × 타깃 결과를 한눈에

**What to build:** Cycle 화면이 테스트 × 타깃 매트릭스를 셀 색(verified·passed-flaky·failed·blocked·skipped·대기)으로, Cycle Verdict 와 Run 행(상태·기기·노드·대체·버려짐)을 보여 주고, 진행 중이면 주기적으로 새로 고친다.

**Blocked by:** 01

**Status:** done

- [x] 매트릭스(행 = 테스트, 열 = 타깃), 셀 색·범례, 경고(warnings) 표시
- [x] Run 행: state, deviceId, agentId, replaces/replacedBy/abandonedAt, retriesUsed
- [x] 끝나지 않은 Cycle 은 자동 새로 고침(간격 이유 주석), 끝나면 멈춤
- [x] 테스트: 가짜 API 로 셀 색·대체 Run·자동 새로 고침 멈춤

## Comments

- 2026-11-09 구현(seam 2개 승인): `pages/CycleView.tsx` — 머리(빌드·상태·Verdict·필수 태그·경고), 매트릭스(행 테스트·열 타깃, 셀 통과·통과(흔들림)·실패·막힘·건너뜀·면제·대기 색, 필수 표시, 범례, 결과 있는 셀은 03 상세 링크 `/console/cycles/:id/cases/:test/:target`), Run 행(상태·기기 끝 4자리·노드·대체 관계·버려진 시각, 타깃별 대체 n/한도). `usePolling` 이 끝나지 않은 Cycle 을 5초마다(이유 주석) 다시 부르고 finished·expired·cancelled 면 멈춤, 떠나면 타이머 정리, 오류면 멈추고 사유.
