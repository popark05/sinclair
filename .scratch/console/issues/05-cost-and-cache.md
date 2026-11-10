# 05: 비용·캐시 적중률 — Cycle 이 모델을 얼마나 썼는지 본다

**What to build:** control-plane 에 Cycle 사용량 집계 API(`GET /cycles/:id/usage` — 모델 호출 수, 입력·출력 토큰, 캐시 읽기·쓰기, 캐시 적중률, 타깃·테스트별)를 더하고, Console 의 Cycle 화면에 요약과 표를 보여 준다.

**Blocked by:** 02

**Status:** done

- [x] 집계 API(투영의 스텝 usage 합, 대체된 Run 제외 여부 명시), 계약 테스트
- [x] 화면: Cycle 합계, 타깃·테스트별 표, 캐시 적중률(읽기 / (입력+읽기+쓰기))
- [x] 테스트: 집계 수치(독립 계산값), 화면 표시

## Comments

- 2026-11-10 구현(승인): control-plane `GET /cycles/:id/usage`(`insights.ts` `cycleUsage` — 대체된 Run 포함, 합계·타깃별·테스트별 모델 호출·입력·출력·캐시 읽기·쓰기, 캐시 적중률 = 읽기/(입력+읽기+쓰기), 분모 0 이면 null; 손 계산값과 비교하는 테스트). Console `UsageSection`(Cycle 화면의 '모델 사용' 절: 카드 6개 + 타깃·테스트별 표, 호출 많은 순, 호출 0 이면 숨김). 달러 환산 없음(단가 변동·요약 모델 토큰 섞임).
