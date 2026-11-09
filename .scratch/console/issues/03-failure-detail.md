# 03: 실패 상세 + 공유 링크 — 셀을 누르면 왜 실패했는지 본다

**What to build:** 매트릭스 셀에서 그 케이스의 Attempt 들(재시도 포함)과 스텝(locator/assert/act/판정 동사 — instruction, 소요 시간, modelCalls, 토큰, 안전망·Incident 표시), errorCode, 아티팩트 목록을 보고, URL(`/console/cycles/:id/cases/:test/:target`)로 공유한다.

**Blocked by:** 02

**Status:** done

- [x] 케이스 상세 화면과 직접 URL 진입
- [x] 스텝 표시: 종류별, 실패 스텝 강조, 안전망(`다시 찾음`·`안전망:`)·`[Incident: …]` 표시
- [x] 아티팩트는 키 목록(이미지 표시는 아티팩트 업로드 티켓 후속)
- [x] 테스트: 가짜 API 로 재시도 Attempt 둘, 에이전트 스텝 표시, URL 진입

## Comments

- 2026-11-09 구현(seam 승인): `pages/CaseView.tsx` — Cycle 뷰에서 그 타깃의 Run(대체된 Run 포함, "대체됨" 표시)을 `GET /runs/:id` 로 받아 그 테스트의 시도를 시작 시각 순으로. 시도마다 결과 배지·errorCode·소요 시간·Run, 스텝 표(종류·instruction·시간·모델 호출·토큰 입력/출력/캐시 읽기), 실패 스텝 강조, 표지 `안전망 n`·`다시 찾음 n`·`Incident`(러너 instruction 형식에서), 아티팩트 키 목록. App 라우팅으로 공유 링크 직접 진입. control-plane 변경 없음.
- 남긴 것: 스크린샷·트리 표시는 아티팩트 업로드 후속.
