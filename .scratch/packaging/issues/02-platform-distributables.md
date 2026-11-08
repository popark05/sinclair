# 02: 플랫폼별 배포본 조립 — zip 하나로 QA 노드에 설치한다

**What to build:** `pnpm dist [--targets mac-arm64,mac-x64,win-x64,win-arm64]` 가 타깃마다 `release/sinclair-<version>-<target>.zip` 을 만든다. 안에는 고정 버전 Node 실행 파일(SHA-256 검증, LICENSE 동봉; EverMock `fetch-node` 패턴, 코드 복사 없이), 01 의 두 번들, 해당 플랫폼의 `@node-usb` 네이티브 패키지(`scripts/fetch-usb-binaries.mjs` 재사용), `resources/helper/sinclair-helper-<V>.apk` + `.sha256`, 실행 스크립트(`bin/sinclair-control-plane`, `bin/sinclair-agent`; mac/Linux `.sh`, Windows `.cmd`), `VERSION`, `README`(설치·Gatekeeper 우회·사내망 CA). QA 담당자는 zip 을 풀고 실행 스크립트만 치면 된다.

**설치 레이아웃 계약(01 이 코드로 전제하는 것):**
- `<install>/dist/{control-plane,runner-agent,runner,hooks}.mjs` + `chunk-*.mjs` 가 한 디렉터리에(훅은 `./runner.mjs`, 청크는 상대 import).
- `<install>/resources/helper/sinclair-helper-<V>.apk` + `.sha256` (`resourcesDir()` = `<dist>/../resources`; `SINCLAIR_RESOURCES_DIR` 로 덮어쓸 수 있음).
- `usb`: Node 해석이 `<install>/dist/node_modules/usb` → `<install>/node_modules/usb` 순으로 올라간다. **`<install>/node_modules/usb` + `@node-usb/usb-<platform>`** 에 둔다.
- 런처는 동봉 Node 24 계열로 `dist/<app>.mjs` 를 플래그 없이 실행(`--no-warnings=ExperimentalWarning` 만). 사용자 테스트 파일 `.ts` 는 네이티브 타입 스트리핑에 의존(22.18+).

**Blocked by:** 01 (번들)

**Status:** done

- [x] Node 버전 고정 상수(≥22.13, `node:sqlite` 때문)와 타깃별 다운로드 URL·SHA-256 검증·캐시(`~/Library/Caches` 류), 사내망이면 `NODE_EXTRA_CA_CERTS` 를 따른다. 실패 사유가 명확하다
- [x] 실행 스크립트는 동봉 Node 로 번들을 실행하고 `--experimental-*` 플래그가 필요 없다(Node 24 에서 `node:sqlite` 경고만 끈다). 환경변수(`SINCLAIR_CP_*`, `SINCLAIR_AGENT_*`)는 그대로 통과
- [x] 헬퍼 APK 는 리포 빌드에서 복사하고 없으면 조립이 실패한다(빌드 절차 안내 메시지). `.sha256` 사이드카를 함께 만든다
- [x] 테스트: 호스트 타깃 배포본을 임시 디렉터리에 풀어 실행 스크립트로 서버 기동(READY, sqlite 기본) → `sinclair-agent run --engine fake` → `GET /cycles/:id` verified → 서버 SIGTERM 정상 종료. 기기 없이 `--engine mobile` 은 "기기 없음" blocked(2) 로 끝난다(USB 로드 성공 확인)
- [x] 배포본 크기·구성 목록을 README 에 적고, 서명이 없다는 점과 macOS 격리 속성 제거(`xattr -dr com.apple.quarantine`) 절차를 쓴다

## Comments

- 2026-11-08: 완료. `scripts/dist.mjs`(`pnpm dist [--targets …] [--out] [--node-binary] [--no-zip]`): `fetchNode(target)` 가 `NODE_VERSION = 24.13.0` 을 nodejs.org 에서 받아 `SHASUMS256.txt` 로 검증 후 OS 캐시 디렉터리(`~/Library/Caches/sinclair/node` 등)에 풀고 LICENSE 포함, 캐시면 네트워크 없음(사내망은 `NODE_EXTRA_CA_CERTS`); `assembleDistributable({target,…})` 가 레이아웃 계약대로 `bin/`(sh 또는 .cmd 런처, `--no-warnings=ExperimentalWarning` 만), `node/`, `dist/`(01 번들), `node_modules/usb` + `@node-usb/usb-<platform>`(`fetch-usb-binaries.mjs` 를 `ensureUsbPackage()` 로 리팩터해 재사용), `resources/helper/sinclair-helper-<V>.apk`+`.sha256`(리포 빌드 없으면 실패 + 빌드 안내), `VERSION`, `README.md`(실행·구성·Gatekeeper `xattr -dr com.apple.quarantine`·사내망·기기 안내)를 조립하고 `zip -qry` 로 `release/sinclair-<version>-<target>.zip`. 루트 package.json version 0.1.0. 테스트 `dist.test.ts`: fetchNode(페이크 릴리스 서버: 검증·캐시·불일치 거부), 호스트 배포본을 현재 Node 로 조립해 zip 을 풀고 런처로 control-plane(sqlite 기본 READY, ingest, 환경변수 통과, SIGTERM 종료 완료), agent(`run --engine fake` verified; `--engine mobile --device NO-SUCH-DEVICE` → blocked(2) 와 "번들 APK (bundled)"·"목록에 없음" 로그 = usb 모듈·APK 로드 확인), Windows 타깃 교차 조립(node.exe, .cmd, win32 usb 패키지). 실제 `pnpm dist --targets mac-x64`: Node 다운로드·검증 포함 9.5초, 38.8 MB zip; /tmp 에 풀어 런처로 서버·에이전트·종료까지 수동 확인.
- 결정: Node 는 24.13.0 고정(호스트와 동일 LTS 계열). 배포본의 `usb` 는 `<install>/node_modules` 에(Node 해석이 dist 에서 위로 올라감). 서명 없음 → README 에 격리 속성 제거 절차. 관찰: 기기가 꽂힌 머신에서 `--device NO-SUCH-DEVICE` 테스트가 60초 가까이 걸림(실기기 probe 대기) — 기기 없는 CI 에서는 3초.
- 2026-11-08 리뷰 반영(Standards + Spec): (1) 헬퍼 버전·파일명·리포 빌드 경로의 단일 출처 — `dist.mjs` 가 `apps/runner-agent/src/helper-apk.ts` 를 직접 import(타입 스트리핑), 테스트도 `helperApkFileName()` 사용. (2) README 에 설치 크기(압축 전) 기재. (3) Node LICENSE 필수: `--node-binary` 면 `<prefix>/LICENSE` 를 찾고 없으면 실패(`--node-license` 로 지정), 구성 테스트가 `node/LICENSE` 확인. (4) `--node-binary` 는 타깃 하나일 때만(아니면 오류). (5) APK 부재 실패 경로를 `helperApk` 주입으로 테스트. (6) `SINCLAIR_AGENT_*`(ENGINE·SPOOL) 양성 통과 테스트. (7) fetch 120초 상한 상수에 사유, 네트워크 오류 cause 포함, SHASUMS .sig 미검증을 주석으로 명시, `listFiles` 의 node_modules 접기 사유 주석, 미사용 import 제거. 미반영: 다운로드한 Node 바이너리로 런처를 돌리는 자동 테스트(네트워크 필요) — 03 의 verify-install 이 `fetchNode` 경로로 조립한 zip 을 풀어 `node/node --version` 과 런처 실행을 증거로 남긴다.
