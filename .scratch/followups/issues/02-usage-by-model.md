# 02: 모델별 비용 — 요약 모델(Haiku) 토큰을 본 모델과 나눠 본다

**What to build:** 스텝 사용량에 모델별 분해를 싣고(protocol 계약 먼저), control-plane 사용량 집계·Console 모델 사용 절이 모델별로 보여 준다.

**Blocked by:** None

**Status:** done

## Comments

- 2026-11-10 구현: protocol `StepUsage.byModel`(모델 → `TokenUsage`, 닫힌 검사 — 계약 테스트 먼저), 에이전트 `addUsage` 가 모델별 내역도 합침, Claude 실행기가 응답의 실제 모델(`res.model` — 서버 측 fallback 이면 그 모델)로 내역을 싣고 요약 모델 호출도 그 모델로, control-plane `GET /cycles/:id/usage` 에 `byModel`(토큰·캐시 적중률 — 호출 수는 스텝 단위라 모델로 나누지 않음), Console '모델 사용' 절에 모델별 표(입력 많은 순). 달러 환산은 여전히 하지 않는다(단가 변동 — 모델별 표에 곱하면 된다).
