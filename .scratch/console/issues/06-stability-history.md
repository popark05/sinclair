# 06: 안정성 이력 — 테스트가 여러 Cycle 에서 어땠는지 본다

**What to build:** control-plane 에 테스트별 여러 Cycle 이력 API(`GET /tests/history?testId=…` 또는 Cycle 묶음 — 최근 N Cycle 의 케이스 verdict)를 더하고, Console 에 테스트별 추이(통과·flaky·실패·blocked)와 flaky 비율을 보여 준다.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 이력 API(최근 N, 최신순, 타깃별), 계약 테스트
- [ ] 화면: 테스트별 추이 막대·flaky 비율, 매트릭스 셀에서 이력으로 가는 링크
- [ ] 테스트: 여러 Cycle 이력 집계, 화면 표시
