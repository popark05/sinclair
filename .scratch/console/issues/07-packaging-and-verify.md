# 07: 배포·검증 — 설치본에 Console 이 들어 있고 실제로 열린다

**What to build:** `pnpm dist` 설치본이 Console 정적 파일을 동봉하고 control-plane 런처가 기본으로 `/console` 을 서빙한다. `verify-console` 스킬이 실제 control-plane + 가짜 에이전트로 Cycle 을 채우고 헤드리스 브라우저로 목록·매트릭스·상세·플릿 화면을 확인해 증거를 남긴다.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** done

- [x] 번들·설치본에 Console 동봉, 런처 기본 서빙, 기존 dist 테스트 갱신
- [x] `verify-console` 스킬(Launch/Drive/Evidence), 스크린샷·DOM 증거(개인정보 없음)

## Comments

- 2026-11-10 구현: `scripts/dist.mjs` 가 `buildConsole()`(pnpm --filter @sinclair/console build)로 Console 을 한 번 빌드해 설치본 `resources/console/` 에 넣는다(README 에 `/console/` 안내). control-plane 의 `--console-dir` 기본값은 자산 디렉터리(SINCLAIR_RESOURCES_DIR, 없으면 번들 옆 `../resources`)의 `console/index.html` 이 있으면 그것, `none` 이면 끔 — 번들 가드의 `import.meta.url` 허용 목록에 그 사용처를 더했다(가드가 처음에 잡았다). dist 테스트: 구성에 `resources/console/index.html`, 런처가 `--console-dir` 없이 `/console/`·자산을 서빙.
- `verify-console` 스킬: 실제 control-plane + 가짜 에이전트 Cycle + 노드 보고 → 헤드리스 Chrome 으로 화면 5개(목록·매트릭스·케이스·플릿·이력) DOM 판정과 스크린샷. 2026-11-10 5/5 PASS(`.scratch/console/evidence/verify-console-latest.json`).
- 스킬이 잡은 결함: Cycle 뷰의 Run 행이 노드·기기를 lease 에서만 읽어 `sinclair-agent run`(lease 없음) Run 은 '—' 였다 → control-plane Cycle 뷰의 runs 에 이벤트의 `agentId`·`deviceId` 를 싣고 Console 은 lease 다음으로 그것을 쓴다(계약 테스트 추가).
- 2026-11-10 Console 묶음(01~07) 리뷰 반영(must-fix 2 + should-fix 12 + nit): (M1) 점이 든 경로(app-1.2.3 같은 Cycle id·ios-17.4 타깃·run.1)가 자산으로 오인돼 공유 링크·새로 고침이 404 → 실제 파일이 있을 때만 자산, `assets/` 아래 없는 파일만 404, 그 밖은 index.html. (M2) 대기 중인 대체 Run 이 있으면 케이스 상세가 통째로 실패 → 대기 Run 은 묻지 않고 404 Run 은 뺀다. (S1) 원시 HTTP(%2f·%5c·..)로 경로 탈출 테스트, 해석기 `resolveConsoleFile` 분리(역슬래시·NUL·.. 조각 거부, win32 테스트), 심링크로 루트 밖이면 404. (S2) 버려진 Run 을 가짜 시계로 실제로 만들어 사용량 포함·진행률 제외 확인. (S3) verify-console 판정을 셀 클래스로, 실패 케이스 없으면 오류, 원시 시리얼 없음 확인. (S4) Cycle 경고 문구의 기기 id 끝 4자리. (S5) `usePolling` — 대상이 바뀌면 불러오는 중으로, 일시 오류는 이전 화면 + "새로 고치지 못함" 알림 + 지수 간격(최대 60초) 재시도, 404 면 멈춤; 모델 사용 절도 진행 중엔 새로 고침. (S6) 개발 프록시에 /tests. (S7) cycleId "summary" 예약어 400. (S8) 상한 요약 100·이력 50(Cycle 마다 이벤트를 읽는다). (S9) 직접 준 --console-dir 에 index.html 이 없으면 기동 설정 오류. (S10) HEAD. (S11) pnpm 이 없을 때의 빌드 오류 문구. (S12) verify 스크립트의 기동 대기를 try 안·조기 종료 감지. nit: Run 상태·'지시' 한국어, index.html·비해시 파일은 no-cache, 번들에 서버 코드 없음 검사, 빌드 테스트 임시 디렉터리 정리, 호출 0 숨김 테스트가 불러온 뒤를 본다.
- 남긴 것: 06 의 "매트릭스 셀에서 이력 링크" 는 케이스 상세에 두었다(셀은 상세로 가는 링크라 한 단계 더). agentId 기본값이 호스트명이라 Fleet·Run 행에 그대로 보인다(노드 이름을 정하는 것은 운영 쪽 — `--agent` 로). 요약·이력은 버려진 Run 정리를 하지 않는다(Cycle 상세 조회·클레임 때 정리된다).
