# 06: 안정성 이력 — 테스트가 여러 Cycle 에서 어땠는지 본다

**What to build:** control-plane 에 테스트별 여러 Cycle 이력 API(`GET /tests/history?testId=…` 또는 Cycle 묶음 — 최근 N Cycle 의 케이스 verdict)를 더하고, Console 에 테스트별 추이(통과·flaky·실패·blocked)와 flaky 비율을 보여 준다.

**Blocked by:** 02

**Status:** done

- [x] 이력 API(최근 N, 최신순, 타깃별), 계약 테스트
- [x] 화면: 테스트별 추이 막대·flaky 비율, 매트릭스 셀에서 이력으로 가는 링크
- [x] 테스트: 여러 Cycle 이력 집계, 화면 표시

## Comments

- 2026-11-10 구현(승인): control-plane `GET /tests/history?limit=N&testId=`(`insights.ts` `testHistory` — 최근 N(기본 20, 최대 200) Cycle 의 매트릭스를 테스트별 셀(오래된 → 최신, 타깃 순)·통계·flaky 비율 = 흔들림/(통과+흔들림+실패), flaky 높은 순). Console `/console/tests`(`HistoryPage`: 색 칸 줄 — 칸은 그 케이스 상세 링크·제목에 빌드·타깃·판정, flaky %·실패 수, testId 로 거르기), 케이스 상세에 "이 테스트의 이력" 링크, 머리띠에 안정성.
