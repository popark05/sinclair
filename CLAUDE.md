# CLAUDE.md

## 프로젝트

Sinclair: 모바일(iOS/Android)과 웹 앱을 위한 에이전트 기반 E2E 검증 플랫폼. 자연어로 목표를 주면 에이전트가 앱을 조작해 결정적 테스트 스크립트로 굳히고, 테스트 사이클 단위로 결과를 취합해 검증 현황을 관리한다. 사내 QA용이며 코드 주석, UI 문자열, 커밋 메시지는 한국어로 쓴다.

`reference/` (git-ignored)에는 참고용 외부 프로젝트가 있다. **설계와 패턴만 참고하고 코드를 `apps/`, `packages/`로 복사하지 않는다.**

- `reference/e2e` (Apache-2.0): 러너, 테스트 API, 녹화·재생 캐시, 엔진 계약의 기준.
- `reference/artemis` (Apache-2.0): 에이전트 루프의 안전망, Incident 복구, 컨텍스트(Ledger) 관리, 접근성 헬퍼 APK.
- `reference/mobilenext`: 디바이스 JSON-RPC 표면과 스트리밍 설계. **mobilecli, devicekit-*은 FSL-1.1 라이선스**라 프로토콜 설계만 참고한다. mobilewright, mobile-mcp, react-device-view는 Apache-2.0.

## 명령

```bash
pnpm install
pnpm typecheck        # 모든 워크스페이스 tsc --noEmit
pnpm test             # vitest (packages/*/test, apps/*/test)
pnpm lint             # oxlint
pnpm check            # lint + typecheck + test
npx vitest run packages/protocol   # 단일 패키지
pnpm control-plane -- --help   # 서버 CLI (리포 체크아웃에서 .ts 실행)
pnpm agent run --help          # 에이전트 CLI
pnpm --filter @sinclair/console dev    # Console 개발 서버(API 는 SINCLAIR_CONSOLE_API, 기본 127.0.0.1:4780 프록시); build → apps/console/dist, control-plane --console-dir 로 서빙
pnpm bundle                    # dist/ 에 ESM 번들(control-plane·runner-agent·runner + 훅). 설치본은 .scratch/packaging 참고
```

Node 는 22.18 이상(`node:sqlite` 와 사용자 테스트 파일 `.sinclair.ts` 의 네이티브 타입 스트리핑). 환경변수 `SINCLAIR_RESOURCES_DIR` 로 자산(헬퍼 APK) 위치를, `SINCLAIR_BUNDLED` 는 번들 빌드가 고정한다.

사내망(SSL 인터셉션)에서는 `export NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem` 후 설치한다.

## 구조

```
intent/         Plan 단계 산출물 (intent.md). 문제, 사용자, 제약, 성공 기준
specs/          Design 단계 산출물 (spec.md). 계약·타입·결정이 여기서 확정됨
docs/adr/       아키텍처 결정 기록
GLOSSARY.md     용어집 (루트)
evals/          에이전트 설정(CLAUDE.md, 스킬, hooks) 회귀용 eval 정의
packages/
  protocol/     이벤트 스키마, Run/Attempt 상태, 디바이스 JSON-RPC 타입, 엔진 계약 타입. 다른 패키지가 모두 의존
  device-layer/ 디바이스 JSON-RPC 서버 (adb/usbmux + 온디바이스 에이전트)
  engine-mobile/ 러너 엔진 계약의 모바일 구현 (device-layer 위)
  agent/        에이전트 레이어: agent.act 툴 루프, 닫힌 툴 스키마(단일 action spec), StepExecutor(모델) 경계. protocol 에만 기댄다
  runner/       테스트 러너: locator/expect, agent.act/assert, 녹화·재생 캐시, 리포터
  ui/           공유 React 컴포넌트: device-view, trace-viewer, tree-inspector
apps/
  studio/       Electron 데스크탑 앱 (테스트 작성·디버깅, 라이브 기기 뷰)
  console/      웹 대시보드 (Cycle 매트릭스, Verdict, 이력)
  control-plane/ API 서버 (Cycle/Run/Attempt, Ingest, Fleet, 원격 캐시)
  runner-agent/ 워커 데몬 (기기 연결 노드에서 러너 실행, 이벤트 스트리밍)
```

의존 방향은 `protocol ← device-layer ← engine-mobile ← runner ← apps`, 에이전트는 `protocol ← agent ← runner`(엔진 계약에만 기대 디바이스 레이어를 모른다). 역방향 import 금지. apps 끼리는 런타임 import 를 하지 않는다(서로 HTTP 로만 대화). 테스트 전용 `devDependencies`(예: runner-agent 테스트가 control-plane 을 인프로세스로 띄움)만 허용.

## 핵심 설계 결정 (상세는 specs/)

- 테스트 스크립트 형식과 러너는 e2e 방식(`test`/`expect`/`screen.getByRole`, `agent.act`/`assert`). mobilewright는 locator 해석의 모바일 세부 구현만 참고.
- 녹화 캐시는 검증(assert)이 통과한 뒤에만 기록, 의미 기반 descriptor로 재탐색, 실패 시 에이전트가 스텝 중간부터 이어받음.
- 네트워크 모킹은 EverMock을 `mock` fixture로 불러 쓴다. 기본은 Mock 없는 직접 모드.
- EverMock은 별도 앱으로 유지. 디바이스 레이어는 공유 패키지로 뽑아 하나의 데몬이 기기를 소유한다.

## 작업 방식 (AI-Native SDLC)

Plan(`intent/`) → Design(`specs/`, `/architect`로 타입 먼저) → Build(`to-tickets` → `implement`, `tdd`) → Test(검증 스킬, evals) → Deploy(`code-review`, `/interrogate`, `REVIEW.md`) → Maintain(`retro`, `/reflect`, 실패는 새 intent로).

- 계약(엔진 인터페이스, 이벤트 스키마, JSON-RPC)을 바꾸면 반드시 `packages/protocol`의 계약 테스트를 먼저 갱신한다.
- 버그는 실패하는 테스트를 먼저 커밋한 뒤 고친다.
- 반복된 실수는 아래 "알려진 실수" 절에 추가한다.

## 알려진 실수

- **USB IN 엔드포인트의 잔여 데이터를 별도 `transferIn` 으로 비우지 않는다.** 타임아웃으로 취소된 전송이 뒤이어 오는 adbd 응답을 삼켜 핸드셰이크가 영영 멈춘다(실기기에서 확인). 읽기 루프를 그대로 돌리며 잠시 버리는 방식(`UsbTransport.discardStaleInput`)을 쓴다. 2026-11-07.
- **USB 유휴 읽기를 짧은 timeout 으로 폴링하지 않는다.** node-usb 3(nusb) 는 timeout 취소 순간 도착한 패킷을 버려 스트림이 어긋난다(헬퍼 응답 ~1초와 1초 폴링이 겹쳐 재현). 유휴 timeout 은 60초, 종료는 `UsbTransport.shutdown` 의 wake OPEN 으로 끝낸다. 보류 읽기가 있으면 release/close 가 native borrow 오류로 실패한다. 2026-11-07.
- **일부 adbd 는 헤더와 본문을 한 USB 전송으로 보낸다.** 헤더 24바이트만 요청하면 node-usb 가 잘라낸 나머지가 사라진다. 헤더 읽기는 패킷 하나를 통째로 요청하고 초과분은 `pending` 으로 넘긴다(`UsbTransport.readExact`). 2026-11-07.
- **실기기 테스트에서 `settings put` 은 `--user 0`.** Secure Folder 가 있는 Samsung 은 기본 사용자가 150 으로 잡혀 설정이 엉뚱한 사용자에 쓰인다.
- **막 설치한 접근성 서비스는 첫 `settings put … enabled_accessibility_services` 가 무시된다.** 접근성 관리자가 아직 모르는 컴포넌트를 목록에서 지운다(SM-N981N, Android 13). 1초 간격으로 몇 번 다시 쓴다(`android-backend.ts` `ACTIVATE_RETRIES`). 2026-11-08.

- **입력 직후 화면 트리에는 값이 아직 없다.** 실기기 YouTube 검색창은 `device.io.text` 뒤 약 200ms 동안 value 가 비어 보여, 곧바로 관찰한 에이전트가 빈 칸으로 알고 두 번 입력했다(검색어 중복). engine-mobile `type` 은 값이 트리에 보일 때까지(상한 stabilityTimeoutMs) 기다린 뒤 끝난다. 2026-11-14.
- **실행 키가 키보드에만 있는 앱이 있다.** YouTube 검색은 화면에 검색 버튼이 없고 IME 의 🔍 키뿐이라, 에이전트 툴에 입력 확정이 없으면 입력·지우기를 반복하다 턴 한도로 실패한다. 에이전트 툴 `submit(ref)`(그 칸에서 Enter). 2026-11-14.

- **탭 직후 화면 트리에는 옛 화면이 보인다.** 실기기에서 에이전트가 옛 화면을 보고 같은 탭을 반복했다(안전망이 막지만 턴의 약 1/3 낭비). engine-mobile 은 화면을 바꿀 수 있는 액션(탭·키·스크롤·뒤로) 뒤 트리(역할·이름·testId)가 바뀌기를 `settleChangeMs`(1초)까지, 바뀌면 멈출 때까지 기다린다 — 글자·rect 는 비교하지 않는다(재생 시간·광고 카운트다운). 2026-11-14. 앱 실행(`session.open`·`restart`)도 같다: 스플래시·로딩을 지나 500ms 조용해질 때까지(상한 `launchSettleMs` 8초), `restart` 는 종료 뒤 화면을 기준으로, 이미 그 앱이 화면이면(resource-id 패키지) `open` 은 기다리지 않는다.

- **재생은 라이브보다 훨씬 빨리 끝난다.** 모델 생각 시간이 없어 2초 만에 끝난 재생 뒤 판정이 아직 비어 있는 검색 결과를 봤다(실기기 YouTube). 녹화 재생은 끝 확인 뒤 화면이 1.5초 잠잠해질 때까지 기다린다. 끝 anchor 는 과반만(자동재생 영상 버튼 같은 우연한 UI), 이름 없는 대상은 자식 글자로 라벨. 2026-11-14.

- **내보낸 테스트는 앞 테스트가 남긴 앱 상태 위에서 돈다.** `app.open` 은 이미 떠 있는 앱을 초기화하지 않아, 자연어 테스트가 남긴 YouTube 검색 결과 화면에서 결정적 테스트가 '검색' 버튼을 못 찾았다(실기기). Studio 내보내기 첫 줄은 `app.restart(앱)`(종료 후 실행, 계약 `session.restart(target?)`). 세션도 앱 처음 화면에서 시작해야 녹화가 그 화면과 맞아 재생된다. 2026-11-14.

- **Electron 메인 ↔ plain Node 자식의 IPC 는 `serialization: 'json'`.** 둘의 V8 버전이 달라 `'advanced'`(V8 직렬화) 메시지를 풀지 못한다("Unable to deserialize cloned data") — 같은 Node 로 도는 테스트에서는 드러나지 않는다(Studio 작업 프로세스, 2026-11-14).

## 참고 프로젝트에서 가져올 것 (2026-11-07 분석 요약)

- **e2e**: 세 동사 분리(locator / act / 판정), `StepExecutor` 교체 구조(툴 루프·decision 모델·ACP), 녹화 캐시(검증 후 기록, descriptor 재탐색, 이어받기, strict 모드, 플러거블 스토어), `defineEngine` 계약과 JSON-RPC 엔진 프로토콜, 닫힌 Zod 툴 스키마와 redaction, trace.md/ai-trace/report 스키마. 약점: 판정은 캐시되지 않음, 코어 7만 줄이라 통째 포크 비현실적.
- **artemis**: 액션 전 안전망(`precondition_xml` 가중치 재탐색 + 픽셀/VLM), Incident 기반 복구, TranscriptLedger 4영역 + 백그라운드 시각 요약 + era 청킹, 단일 소스 action spec → 툴 스키마 생성 계약 테스트, plan 문법(verify/assert/@end)과 읽기 전용 Checker, 접근성 헬퍼 APK(UiAutomation 비독점, 스크린샷·트리 원자적). 약점: Android 전용, Gemini 튜닝, 비결정적.
- **mobilenext**: 단일 JSON-RPC 표면(`device.io.*`, `device.dump.ui`, OpenRPC), `ScreenElement` + `@ref`, Android `app_process` dex 에이전트, iOS go-ios + XCUITest 러너, H.264 fan-out 허브, react-device-view(WebCodecs + 입력 전달), mobilewright의 locator 세부(testId 다중 매칭, bounds 체이닝, 2회 연속 동일 bounds). 약점: mobilecli/devicekit은 FSL, idle 동기화 없음, UiAutomation 독점, 서버 무인증.

## 도구 조합

- SDLC 뼈대는 Anthropic AI-Native SDLC Playbook 6단계. 워크플로 진입점은 mattpocock-skills(`grill-me`, `to-spec`, `to-tickets`, `implement`, `pr`), 품질 게이트는 pstack(`/architect`, `/blast-radius`, `/interrogate`, `/create-verification-skill`, `/reflect`). TDD는 mattpocock 것 하나만 쓴다.
- 플러그인 설치됨(user scope). 리포지토리당 1회 `/setup-matt-pocock-skills`, `/pstack:setup-pstack` 실행 필요.

## 작업 로그

### 2026-11-07
- 모노레포 골격, protocol 계약 패키지(계약 테스트 5개), device-layer JSON-RPC 디스패처·HTTP 전송(테스트 6개), ADR 0001~0003.
- 검증 스킬 2개 추가: `.claude/skills/verify-device-layer`(JSON-RPC 서버를 페이크 백엔드로 띄워 HTTP 로 구동, 증거는 `.e2e/verify-device-layer/`)와 `.claude/skills/verify-rpc-serialization`(`rpc.ts` 직렬화의 제한 범위 전수 검사, `packages/device-layer/test/rpc-serialization.exhaustive.test.ts`). `rpc.ts` 를 바꾸면 후자의 sync commit 을 갱신한다.
- 결정: `device.io.swipe` 파라미터 키는 `fromX/fromY/toX/toY` camelCase (`durationMs` 와 같은 규칙).
- android-backend 티켓 01~06 완료(`.scratch/android-backend/`): direct ADB 이식 + AndroidBackend(devices.list, shell 경로 입력·앱·스크린샷), 접근성 헬퍼 APK(`packages/device-layer/android-helper`, `/ping` `/dump`), 헬퍼 온보딩 자동화와 `device.dump.ui`(`device.info.helper` 상태, `-32002`), 원자 스냅샷 `device.snapshot`, 접근성 제스처 입력(`POST /action`, 헬퍼 거부 시 shell fallback, `preferShellInput`). 발견: Samsung Secure Folder 기기는 `settings put` 에 `--user 0` 필수.
- 미결: 배포 환경의 헬퍼 APK 확보(`helperApkPath`, EverMock ApkManager 패턴)는 runner-agent 패키징 티켓에서.
- 다음 티켓 순서: (1) Android 백엔드 — 완료(`.scratch/android-backend/`). (2) `packages/runner` locator/expect 와 엔진 계약 — 완료(`.scratch/runner-locator/`: 계약 스위트·FakeEngine, engine-mobile, screen locator, expect, test()/runTests + `verify-runner` 스킬). (3) control-plane Ingest 와 커스텀 Reporter — 완료(`.scratch/control-plane-ingest/` 01~05: `parseRunEvent` 런타임 검증기, 러너 `Reporter` 훅, Ingest 멱등 저장 + 투영, HTTP Reporter(배치·재시도·413 분할·close), SQLite(`node:sqlite`, ADR 0004), Cycle API + Verdict; `verify-ingest` 스킬). (4) runner-agent — 완료(`.scratch/runner-agent/` 01~05: control-plane 서버 엔트리, `sinclair-agent run|resume|daemon`, 디스크 스풀, Run 클레임·lease, 헬퍼 APK 해석; `verify-runner-agent` 스킬). (5) 패키징 — mac 쪽 완료(`.scratch/packaging/` 01~04: esbuild ESM 번들 + resolve 훅, `pnpm dist` 로 고정 Node·usb·번들 헬퍼 APK·런처 zip(mac arm64/x64, win x64/arm64 교차), `verify-install` 스킬로 설치본 런처·사내망 CA·업그레이드·실기기 번들 APK 증명; 04 는 Windows 머신 체크리스트 수행만 남음 — `.scratch/packaging/windows-checklist.md`). (6) 재시도 정책 — 완료(`.scratch/retry-policy/`: 01 테스트 재시도 `retries`·`suite.retries`·fixture `attemptNo`·passed-flaky, 02 러너 취소 신호 `signal`·cancelled·에이전트 코드 5·데몬이 lease 상실과 SIGTERM 을 같은 길로, 03 버려진 Run(lease 만료 + 유예) 합성 infra-failed·대체 Run `retry:<runId>`·`retryLimit`, 04 대체된 Run 의 heartbeat 409 replaced + `verify-runner-agent/scripts/retry-e2e.sh` 세 경로 종단 증명(memory·SQLite 10/10); 용어는 GLOSSARY "Run 수명과 재시도 정책"). (7) 기기 lease/Fleet — 완료(`.scratch/device-fleet/` 01~06: 01 노드 기기 보고·`GET /fleet`(idle/untrusted/offline, 보고에서 빠진 기기는 offline), mobile 데몬이 디바이스 백엔드 하나를 소유, 02 Run lease 에 `deviceId`(기기 lease, 해제는 파생: 만료·대체·run.finished), 03 타깃 = 기기 선택 조건(protocol `TargetSelector`, targetId 없는 클레임, 가장 오래전 클레임된 기기 먼저, FIFO), 04 run 마다 워커 프로세스(`__worker`, 데몬이 USB 를 갖고 디바이스 RPC 로 제공)·기기마다 동시에, 05 쓸 수 있는 기기만 후보(잠긴 기기는 한 번 깨우고 보안 잠금이면 멈춤), 06 `verify-runner-agent/scripts/fleet-e2e.sh` 종단(11/11) + 실기기 노드·가짜 노드 한 Cycle; 용어는 GLOSSARY "Fleet"). 실기기 테스트는 폰을 '화면 켜짐 상태 유지' 로 두면 잠기지 않는다. (8) 에이전트 레이어 — 진행 중(`.scratch/agent-layer/` 01~08: 01 agent.act 골격·닫힌 툴 스키마, 02 Claude 실행기(Sonnet 5.5 기본, strict 툴, fallback default, 스텝 usage, 키 없음은 blocked agent-config, `SINCLAIR_AGENT_MODEL*`·`SINCLAIR_AGENT_ACT_*`, 사내망 CA 테스트, opt-in 실호출 `SINCLAIR_AGENT_LIVE=1`), 03 판정 동사 agent.assert·waitFor·extract(툴 없이 구조화 출력, secure 추출 거부), 04 비밀값 secret()(자리표시, 입력 순간 치환, 값 일치 가림, `SINCLAIR_SECRET_<이름>`), 05 액션 전 안전망(실행 직전 재관찰·가중치 재탐색 same/moved/gone/ambiguous, 선택 픽셀 덮개 검사), 06 Incident 복구(권한·앱 오류·런처 튕김·키보드·연속 실패, 결정적 복구 먼저·상한 뒤 모델에게 한 번), 07 Ledger(8턴 묶음 요약·화면 변화·예산 8000 과 줄이는 순서, 선택 모델 요약), 08 실기기 종단 — 실제 모델(Sonnet 5.5)로 SM-N981N 에서 통과(`features/agent.md`, 증거 `08-agent-device-live-latest.json`)). 에이전트 레이어 01~08 완료. (10) Console — 완료(`.scratch/console/` 01~07: 골격·Cycle 목록, 매트릭스, 실패 상세·공유 링크, 플릿, 모델 사용, 안정성 이력, 설치본 동봉 + `verify-console` 스킬). (11) 후속 — `.scratch/followups/` 01 아티팩트 업로드 완료(실패 스크린샷·트리를 control-plane 에 올리고 Console 케이스 상세에서 봄), 02 모델별 비용(StepUsage.byModel, Console 모델별 표) 완료, 03 모바일 keyboard.shown(device.io.keyboard, 실기기 확인) 완료, 04 Issue 분류(서명으로 자동 묶음 + 사람 분류, /console/issues) 완료. 05 취소된 Run 자동 재등록(cancelled → 대체 Run `replaceReason: cancelled`, retryLimit 안 씀·타깃당 5, retry-e2e 13/13), 06 노드 레코드 정리(보존 7일 `--node-retention-ms`, `DELETE /fleet/nodes/:agentId`, Console 지우기), 07 케이스 상세 → Issue 링크 완료. (9) 화면 개인정보 가림 — 완료(`.scratch/screen-pii/` 01: 패턴 + `SINCLAIR_AGENT_PII_TERMS`, 모델 요청·기록 모두, 실기기에서 설정 첫 화면 이메일 가림 확인). (12) 녹화 캐시 — 완료(`.scratch/recording-cache/` 01~07: 01 녹화(protocol 항목 계약·저장소 계약 스위트, agent 가 성공한 act 의 툴 호출을 기술자로·끝 anchor, runner 가 검증 뒤 Attempt 끝 커밋), 02 재생(정확히 하나 일치, 모델 없음), 03 이어받기(재생 접두부 안내 handOff, 녹화 갱신, 실패 시 지움), 04 모드(read-only·strict cache-miss/stale), 05 control-plane 공유 저장(SQLite 스키마 5 `/cache/:key`, runner-agent HTTP 저장소·`--cache`), 06 Console(재생·이어받음·라이브·재생률, 스텝 표지), 07 실기기 YouTube: 녹화 → 재생(act 모델 0, Cycle 모델 11→2) → 이어받기 → 다시 재생; 용어는 GLOSSARY). (13) Studio — 완료(`.scratch/studio/` 01~07: Electron 골격 + plain Node 작업 프로세스(ADR 0005, JSON IPC), 데몬 발견 파일로 기기 연결(없으면 직접), Device 패널(500ms 스냅샷·탭·스와이프·입력), Inspector(트리·속성·locator 후보·하이라이트), 에이전트 세션(실제 모델 runAct·턴 타임라인·중지·판정), 코드로 내보내기(자연어 `app.restart`+act+assert·결정적 locator, 녹화 캐시 저장 → 첫 실행부터 재생), `verify-studio` 스킬(Playwright `_electron`, fake 14/14·실기 YouTube 12/12, 자연어 재생 모델 0회); 계약 `session.restart(target?)`·러너 `app.restart(앱)`). 다음 후보: adb 서버 경유 모드 노출(packaging 04 Windows 체크리스트 결과를 보고 결정), 대체 Run 이 돌지 못한 케이스만 돌리기, 계속 바뀌는 화면(자동재생 영상)에서 재생 끝 대기가 상한까지 가는 것.

## Agent skills

### Issue tracker

이슈는 리포 안 `.scratch/<feature>/` 아래 로컬 마크다운 파일로 관리한다. `docs/agents/issue-tracker.md` 참고.

### Triage labels

기본 다섯 라벨(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`)을 그대로 쓴다. `docs/agents/triage-labels.md` 참고.

### Domain docs

single-context: 루트 `GLOSSARY.md` + `docs/adr/`. `docs/agents/domain.md` 참고.
