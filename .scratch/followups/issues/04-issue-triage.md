# 04: Issue 분류 — 실패를 원인별로 묶는다

**What to build:** (정의 필요) 실패 케이스를 원인(제품 결함·테스트 결함·인프라·불안정)별로 분류하고 Console 에서 본다.

**Blocked by:** None

**Status:** done

## Comments

- 2026-11-10 정의(사용자 결정: 자동 묶음 + 사람 분류): Issue = 실패(failed·blocked Attempt)의 서명(errorCode + 실패 스텝 지시에서 기다린 시간·ref·숫자·마지막 화면 요약을 뺀 것)의 sha1 12자리. 다른 테스트가 같은 대상에서 같은 식으로 실패하면 한 Issue. 사람이 분류(제품 결함·테스트 결함·인프라·불안정)·메모(2000자)·티켓 주소(http/https)를 단다. 인프라 errorCode(device-unavailable·agent-config·secret-missing·engine-closed·cancelled)는 추천 infra.
- 구현: control-plane `issues.ts`(`issueSignature`·`listIssues` — 발생은 최근 N Cycle 의 이벤트에서 계산해 저장하지 않음, 발생 많은 순·최신 먼저, `parseTriage` 검증), `GET /issues?limit=`(1~50, 기본 20), `PUT /issues/:id`(category null 이면 미분류로), SQLite 스키마 4(`issues` 테이블 — 분류만 저장, 재시작 뒤 남음). Console `/console/issues`(요약·코드·발생·테스트·최근 발생 → 케이스 상세, 분류 선택·메모·티켓 저장, 추천 표시), 머리띠 Issue. verify-console 7/7.
- 남긴 것: 테스트 이름이 다르면 같은 원인이어도 지시의 대상 글자가 달라 따로 묶일 수 있다(서명 규칙을 바꾸려면 issueSignature 한 곳). 케이스 상세에서 그 Issue 로 가는 링크는 아직 없다.
