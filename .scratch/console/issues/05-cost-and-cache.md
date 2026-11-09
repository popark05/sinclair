# 05: 비용·캐시 적중률 — Cycle 이 모델을 얼마나 썼는지 본다

**What to build:** control-plane 에 Cycle 사용량 집계 API(`GET /cycles/:id/usage` — 모델 호출 수, 입력·출력 토큰, 캐시 읽기·쓰기, 캐시 적중률, 타깃·테스트별)를 더하고, Console 의 Cycle 화면에 요약과 표를 보여 준다.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 집계 API(투영의 스텝 usage 합, 대체된 Run 제외 여부 명시), 계약 테스트
- [ ] 화면: Cycle 합계, 타깃·테스트별 표, 캐시 적중률(읽기 / (입력+읽기+쓰기))
- [ ] 테스트: 집계 수치(독립 계산값), 화면 표시
