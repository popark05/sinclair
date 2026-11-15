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
node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify.ts --no-build --device [--platform ios|android] [--control-plane URL] [--app ID] [--goal 문장] [--judge 문장] [--element 트리 검색어]
# iPhone 예: --platform ios --app com.apple.Preferences --goal '설정 앱에서 "일반" 안의 "키보드" 설정 화면을 연다' --judge '"키보드" 설정 화면이 열려 있다' --element '텍스트 대치'
```

- **fake**: 스크립트가 가짜 기기 서버(로그인 → 환영 화면, 실제 PNG, 탭 좌표 hit-test)를 띄워 임시 발견 파일(`SINCLAIR_DEVICE_RPC_FILE`)로 Studio 에 붙이고, 가짜 Claude API(`ANTHROPIC_BASE_URL`: count_tokens, 화면을 보고 type→tap→done, 판정은 "환영합니다" 가 보이면 참)와 메모리 control-plane 을 띄운다. 내보낸 테스트는 `runTests` + engine-mobile(같은 가짜 기기) + HTTP 녹화 저장소로 돈다.
- **--device**: 데몬의 디바이스 RPC·실제 모델. 내보낸 테스트를 `.e2e/verify-studio-suite/` 에 쓰고 Cycle 로 등록해 **그 데몬이** 돌린다. 데몬이 테스트 파일의 `@sinclair/runner` 를 자기 runner 로 넘긴다(리포 체크아웃도 resolve 훅 — studio-console 01).

## 설치본(studio-packaging 04)

`pnpm dist:studio` 로 만든 .app 을 **리포 밖**(`~/Library/Caches/sinclair-verify-install/run-*` — LaunchServices 는 /private/tmp·/var/folders 아래 앱을 URL 처리기로 고르지 않는다)으로 복사해, PATH 에 node 가 없는 환경에서 Playwright `executablePath` 로 띄운다. 약 1분(빌드 포함 약 2분).

```bash
node --experimental-transform-types --no-warnings .claude/skills/verify-studio/scripts/verify-install.ts [--no-build] [--control-plane URL]
```

검사: LaunchServices 가 `sinclair://` 처리기로 그 복사본을 고름(빌드 직후 LaunchServices 가 리포 빌드를 늦게 다시 등록하므로 맞을 때까지 다시) → 앱 아이콘(Info.plist 의 icns 가 리포 `apps/studio/build/icon.icns`) → 동봉 CLI(PATH 에 건 심링크 `sinclair-agent --help`, `sinclair-control-plane` 이 동봉 Console 서빙, 리포 밖 테스트 폴더 FakeEngine run → Cycle verified, 시스템 node 없음) → `app.isPackaged`·리포 밖 Resources → 작업 프로세스 "준비됨 · Node v<dist.mjs NODE_VERSION>" → 임시 env 파일(`SINCLAIR_ENV_FILE`)의 `ANTHROPIC_API_KEY`·`ANTHROPIC_BASE_URL` 이 작업 프로세스까지(가짜 API 가 그 키로 count_tokens 를 받음, `PATH=` 줄은 무시돼야) → 데몬이 있으면: 툴바 "데몬", 열기 요청 + `open sinclair://open?request=<id>` 가 실행 중 인스턴스의 open-url(새 인스턴스 없음)·목표 칸이 2초 안(폴링 3초 전)에 채워짐 → Studio 를 끄고 링크로 **콜드 스타트**(`open --env` 로 임시 userData) 해 그 요청을 ack → **자동 업데이트**: 같은 빌드의 Info.plist 버전만 99.0.0 으로 올린 zip·`latest-mac.json` 을 동봉 CLI control-plane `--studio-releases-dir` 로 배포한다. 그 control-plane 을 설정한 설치본이 툴바에 `업데이트 99.0.0` 을 띄우면 누르고, 같은 자리의 앱이 99.0.0 으로 바뀌어 새 프로세스로 다시 뜨는지, 교체 뒤에도 PATH 의 CLI 링크가 도는지 본다. 모두 16개. 끝나면 LaunchServices 등록·프로세스·임시 폴더를 지운다. 증거: `.scratch/studio-packaging/evidence/verify-install-latest.json`. 스크린샷 없음(실기 화면).

함정: 리포의 `release/studio/*/Sinclair Studio.app` 이 등록돼 있으면 `open` 이 그쪽을 새로 띄운다 — 스크립트가 검증 전에 등록을 해제한다. open-url 리스너는 링크를 열기 **전에** 걸어야 한다(먼저 열면 이벤트를 놓친다).

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
- 2026-11-14: 현재 앱(device.apps.foreground)·툴바 상태·비밀값 칸·요소 판정 이후 재실행 — 현재 앱 검사 추가(툴바 상태에 `현재 앱: <앱>`). fake 19/19, 실기 17/17(Cycle verified, 자연어 재생 calls=0). 간편비밀번호 흐름은 사용자 실기로 확인(agent-secrets 03).
- 2026-11-14: studio-console — 설정 대화상자(임시 userData: `SINCLAIR_STUDIO_USER_DATA`)로 control-plane·테스트 폴더를 바꾸고, 내보내기 "Cycle 로 실행"(테스트 폴더에 쓰기·deviceId 타깃·Console 링크 200; fake 는 대기 중, 실기는 데몬이 돌려 끝 · verified). fake 24/24, 실기 22/22. control-plane 이 오래 떠 있었으면 새 계약(deviceId)을 모르니 다시 띄운다.
- 2026-11-14: Console → Studio(studio-console 06) — Console 의 'Studio 에서 열기' 와 같은 요청을 control-plane 에 남기면 Studio 가 목표를 채우고 ack 하는지. fake 25/25, 실기 23/23.
