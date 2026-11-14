---
name: verify-studio
description: "Sinclair Studio(apps/studio Electron 앱)를 빌드해 실제로 띄우고 Playwright _electron 으로 사용자 경로(기기 화면·화면 클릭 탭·Inspector 하이라이트와 locator 후보·트리 검색·에이전트 세션·지금 화면 판정·자연어/결정적 내보내기·클립보드 복사·녹화 캐시 저장)를 끝까지 구동한 뒤, 내보낸 테스트를 실제로 돌려 통과(자연어는 녹화 재생으로 모델 0회)하는지 증명한다. Studio 의 화면·IPC·작업 프로세스·세션·내보내기를 바꿨거나, 내보내기(export.ts)·녹화 캐시 키·엔진 session 계약을 바꿨을 때, 또는 'Studio 가 실제로 도는지 보여 달라'는 요청에 쓴다."
---

# verify-studio

Studio 는 Electron 창 + plain Node 작업 프로세스(ADR 0005)다. 컴포넌트·IPC 단위 테스트(`apps/studio/test`)는 `pnpm test` 가 한다. 이 스킬은 **빌드된 앱을 실제 Electron 으로** 띄워 사람이 하는 순서대로 구동하고, 내보낸 코드가 정말 도는지까지 본다.

## Launch

전제: Node 22.18+, `pnpm install`(Studio devDependency `playwright-core` — 브라우저 다운로드 없음, 리포의 Electron 을 쓴다).

```bash
# 기본(fake): 기기·API 키 없이 약 40초(빌드 포함)
node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify.ts
node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify.ts --no-build

# 실기기: 데몬이 떠 있어야 한다(발견 파일로 디바이스 RPC 공개). 실제 모델 키는 ~/.config/sinclair/env. 약 1분, 모델 약 6회
node apps/runner-agent/bin/sinclair-agent.mjs daemon --control-plane http://127.0.0.1:4780 --tests <아무 디렉터리> --engine mobile --app com.google.android.youtube --agent real-node &   # control-plane 도 4780 에
node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify.ts --no-build --device [--control-plane URL] [--app ID] [--goal 문장] [--judge 문장]
```

- **fake**: 스크립트가 가짜 기기 서버(로그인 → 환영 화면, 실제 PNG, 탭 좌표 hit-test)를 띄워 임시 발견 파일(`SINCLAIR_DEVICE_RPC_FILE`)로 Studio 에 붙이고, 가짜 Claude API(`ANTHROPIC_BASE_URL`: count_tokens, 화면을 보고 type→tap→done, 판정은 "환영합니다" 가 보이면 참)와 메모리 control-plane 을 띄운다. 내보낸 테스트는 `runTests` + engine-mobile(같은 가짜 기기) + HTTP 녹화 저장소로 돈다.
- **--device**: 데몬의 디바이스 RPC·실제 모델. 내보낸 테스트를 `.e2e/verify-studio-suite/` 에 쓰고 Cycle 로 등록해 **그 데몬이** 돌린다. 리포 체크아웃의 데몬은 번들 resolve 훅이 없으므로 suite 에 `node_modules/@sinclair/runner` 심볼릭 링크를 만든다(설치본은 훅이 처리).

## Drive (검사 순서)

1. 툴바 연결 방식 "데몬"(발견 파일로 붙음), 기기 화면 `<img>` 가 원본 크기로 로드.
2. 화면 클릭 → 그 자리 노드 하이라이트(`선택한 노드 영역`), fake 는 기기에 간 탭 좌표가 기기 픽셀과 ±3 이내(여백·배율 변환), 속성 탭의 locator 후보(입력칸은 testId).
3. fake: 트리 검색 "로그인" → 노드 선택 → `getByRole('button', { name: '로그인', exact: true })`.
4. 에이전트 준비 점검(모델 표시) → "앱 처음부터 시작" 이 기본으로 켜졌는지(툴바 앱 id) → 목표 입력·실행(작업 프로세스가 앱을 restart 한 뒤 runAct) → `세션 결과` 가 "성공" + 턴 타임라인.
5. 지금 화면 판정 = 참.
6. 내보내기: 처음부터 시작한 세션이라 경고 없음, 자연어(`app.restart` + `agent.act` + `agent.assert`) 복사 → 클립보드(main 프로세스 `clipboard.readText`)와 비교, 녹화 캐시에 저장, 결정적으로 바꾸고 이름을 `· 결정적` 으로(같은 suite 에 같은 testId 를 두지 않게) 복사.
7. 내보낸 두 테스트 실행: 둘 다 passed, 자연어 act 스텝 `cache=replayed`·act 모델 0회.

## Evidence

- `.scratch/studio/evidence/verify-studio-latest.json`(fake), `verify-studio-device-latest.json`(실기): 검사별 PASS/FAIL·세부(턴·결과 문구·locator·Cycle verdict). 리포에 남는다.
- `.e2e/verify-studio/*.png`(git-ignore): fake 만 단계별 창 스크린샷(01 Inspector, 02 세션, 03·04 내보내기). **실기 모드는 기기 화면에 개인정보가 보일 수 있어 스크린샷을 남기지 않는다.**

## Cleanup

스크립트가 Electron·가짜 서버·control-plane 을 끄고 임시 디렉터리를 지운다. 실기 모드는 데몬·control-plane 을 건드리지 않는다(사용자가 띄운 것). 내보낸 Cycle 은 control-plane 에 남는다(`verify-studio-<시각>`).

## 함정

- **화면 클릭은 실제 탭이다.** Inspector 검사의 클릭이 실기 화면을 바꾼다 — 세션의 "앱 처음부터 시작"(studio 08)이 앱을 다시 띄워 바로잡는다. 그 옵션을 끄고 세션이 앱 처음 화면이 아닌 곳에서 시작하면 내보낸 자연어 테스트(`app.restart` 로 처음 화면에서 시작)의 녹화 첫 대상이 맞지 않아 재생 대신 라이브로 돈다(경고만 남고 통과는 한다).
- **이름이 같은 두 테스트**를 한 suite 에 두면 Cycle 셀이 하나로 합쳐져 실패가 verified 에 가려진다.
- 녹화 재생이 안 된 이유(Run 이벤트에는 안 남는 테스트 경고)를 보려면 `.e2e/studio/replay-diag*.ts` 처럼 `runTests` 를 직접 불러 `t.warnings` 를 찍는다.

## 검증 이력

- 2026-11-14: 최초(studio 07). fake 14/14. 실기 SM-N981N·YouTube 12/12 — Cycle verified(자연어·결정적 둘 다 통과), 자연어 act `cache=replayed calls=0`. 처음 실기 실행에서 (1) suite 의 `@sinclair/runner` 해석 실패, (2) 같은 이름 두 테스트가 Cycle 셀에서 합쳐져 결정적 실패가 가려짐, (3) 앞 테스트가 남긴 검색 결과 화면에서 결정적 테스트가 '검색' 버튼을 못 찾음(`app.open` 은 상태를 버리지 않음) → 계약 `session.restart(target?)`·러너 `app.restart(앱)`·내보내기 첫 줄 `app.restart`, (4) Inspector 클릭이 화면을 바꿔 녹화가 처음 화면과 어긋남 → 세션 전에 앱 재실행.
- 2026-11-14: studio 08 "앱 처음부터 시작" — 스크립트의 직접 restart 를 빼고 세션 체크박스로. 검사 2개 추가(기본 켬, 내보내기 경고 없음). fake 16/16, 실기 14/14(Cycle verified, 자연어 재생 calls=0).
- 2026-11-14: studio 09 요소 판정 — 트리 검색으로 노드를 고르고(화면 탭 없이) "보인다" 를 모델 없이 판정, 결정적 내보내기에 `expect(...)` 가 들어가는지. fake 18/18, 실기 16/16. 판정 버튼은 이름 exact("요소 판정" 과 겹친다). 이 실행에서 메인 프로세스 import 사고(앱이 뜨지 않음)를 잡았다 — electron.launch 시간 초과면 앱을 직접 띄워 "App threw an error during load" 를 본다.
