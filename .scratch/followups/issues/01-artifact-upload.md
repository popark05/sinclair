# 01: 아티팩트 업로드 — 실패 스크린샷·화면 트리를 Console 에서 본다

**What to build:** runner-agent 가 run 이 끝나면 실패 Attempt 의 아티팩트(screenshot·screen-tree)를 control-plane 에 올리고(`PUT /artifacts/:runId/:key`), control-plane 이 저장·서빙하며(`GET`), Console 케이스 상세가 스크린샷을 그림으로, 트리를 링크로 보여 준다.

**Blocked by:** None

**Status:** done

- [x] control-plane: 저장(메모리 또는 `--artifacts-dir`, 기본 데이터 디렉터리/artifacts), 키 검증(경로 탈출 없음), 크기 상한, 이벤트에 신고된 키만 받음, content-type
- [x] runner-agent: 기본 아티팩트 디렉터리(스풀 옆), run 뒤 신고된 아티팩트 업로드(재시도·실패는 로그, run 결과는 바꾸지 않음), `--no-upload-artifacts`
- [x] Console: 케이스 상세에 스크린샷 그림·트리 링크
- [x] 개인정보: screen-tree 는 이미 가려짐, 스크린샷 픽셀은 가리지 못함(문서)

## Comments

- 2026-11-10 구현: control-plane `artifacts.ts`(메모리·파일 저장소 — run id 는 인코딩한 디렉터리, 임시 파일 뒤 rename), `PUT /artifacts/:runId/:key`(run 이 attempt.finished 로 신고한 키만 — 모르는 run 404, 신고 안 됨 409, 키 검사 400, 20MB 상한 413), `GET`(확장자 content-type, nosniff, immutable). `--artifacts-dir`/`SINCLAIR_CP_ARTIFACTS_DIR`(기본 sqlite 면 데이터 디렉터리/artifacts, memory 면 메모리 — 재기동 뒤에도 남는 것 테스트).
- runner-agent: 실패 스냅샷 기본 디렉터리 = 스풀 옆 `artifacts/`(이제 기본으로 남긴다), run 뒤 신고된 키를 올리고(이벤트가 늦게 닿으면 404·409 라 3번 재시도) 올린 기본 디렉터리 파일은 지움, 실패는 로그만(run 결과 불변), `--upload-artifacts on|off`/`SINCLAIR_AGENT_UPLOAD_ARTIFACTS`.
- Console: 케이스 상세의 스크린샷은 그림(누르면 새 탭, 못 받으면 숨김), 화면 트리는 링크. 개발 프록시에 /artifacts. verify-console 에 업로드·서빙과 그림 확인(6/6 PASS).
- 개인정보: screen-tree 는 비밀값·화면 개인정보 가림을 거친다. 스크린샷 픽셀은 가리지 못한다 — 도움말(`--upload-artifacts`, `--artifacts-dir`)에 적었다. 끄려면 `--upload-artifacts off`.
