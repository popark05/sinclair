# 08: 세션을 앱 처음 화면에서 — "앱 처음부터" 옵션과 내보내기 경고

**What to build:** 내보낸 테스트는 첫 줄 `app.restart(앱)` 으로 앱 처음 화면에서 시작한다(07). 세션이 다른 화면에서 시작했으면 녹화의 첫 대상·결정적 locator 가 처음 화면과 맞지 않아 재생 대신 라이브로 돌거나 실패한다(07 실기). 세션 패널에 "앱 처음부터 시작"(앱 id 가 있으면 기본 켬): 실행하면 작업 프로세스가 그 앱을 `session.restart(앱)` 한 뒤 runAct. 결과에 `freshStart`. 내보내기는 처음부터 시작하지 않은 세션이면 경고한다.

**Blocked by:** 07

**Status:** done

- [x] IPC `session-start` 에 `restartApp`(앱 id 형식 검사), 작업 프로세스가 restart 뒤 runAct, 결과 `freshStart`
- [x] 세션 패널 체크박스(앱 id 없으면 끔·비활성), 내보내기 경고
- [x] verify-studio 가 체크박스로 처음부터 시작(스크립트의 직접 restart 제거), fake·실기

## 결과 (2026-11-14)

- IPC `session-start.restartApp`(패키지 이름 형식 `APP_ID` 만), 작업 프로세스가 `session.restart(앱)` 뒤 runAct, 실패하면 목표를 돌리지 않고 "처음부터 시작하지 못함", 결과 `freshStart`.
- 세션 패널 "앱 처음부터 시작"(툴바 앱 id 가 형식에 맞으면 기본 켬, 없으면 끔·비활성), 내보내기는 `freshStart` 가 아니면 경고.
- verify-studio: fake 16/16, 실기 SM-N981N YouTube 14/14 — 세션이 스스로 앱을 다시 띄워 시작, Cycle verified, 자연어 act `cache=replayed calls=0`.
