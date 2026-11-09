# 03: 실패 상세 + 공유 링크 — 셀을 누르면 왜 실패했는지 본다

**What to build:** 매트릭스 셀에서 그 케이스의 Attempt 들(재시도 포함)과 스텝(locator/assert/act/판정 동사 — instruction, 소요 시간, modelCalls, 토큰, 안전망·Incident 표시), errorCode, 아티팩트 목록을 보고, URL(`/console/cycles/:id/cases/:test/:target`)로 공유한다.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 케이스 상세 화면과 직접 URL 진입
- [ ] 스텝 표시: 종류별, 실패 스텝 강조, 안전망(`다시 찾음`·`안전망:`)·`[Incident: …]` 표시
- [ ] 아티팩트는 키 목록(이미지 표시는 아티팩트 업로드 티켓 후속)
- [ ] 테스트: 가짜 API 로 재시도 Attempt 둘, 에이전트 스텝 표시, URL 진입
