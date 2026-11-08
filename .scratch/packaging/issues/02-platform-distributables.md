# 02: 플랫폼별 배포본 조립 — zip 하나로 QA 노드에 설치한다

**What to build:** `pnpm dist [--targets mac-arm64,mac-x64,win-x64,win-arm64]` 가 타깃마다 `release/sinclair-<version>-<target>.zip` 을 만든다. 안에는 고정 버전 Node 실행 파일(SHA-256 검증, LICENSE 동봉; EverMock `fetch-node` 패턴, 코드 복사 없이), 01 의 두 번들, 해당 플랫폼의 `@node-usb` 네이티브 패키지(`scripts/fetch-usb-binaries.mjs` 재사용), `resources/helper/sinclair-helper-<V>.apk` + `.sha256`, 실행 스크립트(`bin/sinclair-control-plane`, `bin/sinclair-agent`; mac/Linux `.sh`, Windows `.cmd`), `VERSION`, `README`(설치·Gatekeeper 우회·사내망 CA). QA 담당자는 zip 을 풀고 실행 스크립트만 치면 된다.

**설치 레이아웃 계약(01 이 코드로 전제하는 것):**
- `<install>/dist/{control-plane,runner-agent,runner,hooks}.mjs` + `chunk-*.mjs` 가 한 디렉터리에(훅은 `./runner.mjs`, 청크는 상대 import).
- `<install>/resources/helper/sinclair-helper-<V>.apk` + `.sha256` (`resourcesDir()` = `<dist>/../resources`; `SINCLAIR_RESOURCES_DIR` 로 덮어쓸 수 있음).
- `usb`: Node 해석이 `<install>/dist/node_modules/usb` → `<install>/node_modules/usb` 순으로 올라간다. **`<install>/node_modules/usb` + `@node-usb/usb-<platform>`** 에 둔다.
- 런처는 동봉 Node 24 계열로 `dist/<app>.mjs` 를 플래그 없이 실행(`--no-warnings=ExperimentalWarning` 만). 사용자 테스트 파일 `.ts` 는 네이티브 타입 스트리핑에 의존(22.18+).

**Blocked by:** 01 (번들)

**Status:** ready-for-agent

- [ ] Node 버전 고정 상수(≥22.13, `node:sqlite` 때문)와 타깃별 다운로드 URL·SHA-256 검증·캐시(`~/Library/Caches` 류), 사내망이면 `NODE_EXTRA_CA_CERTS` 를 따른다. 실패 사유가 명확하다
- [ ] 실행 스크립트는 동봉 Node 로 번들을 실행하고 `--experimental-*` 플래그가 필요 없다(Node 24 에서 `node:sqlite` 경고만 끈다). 환경변수(`SINCLAIR_CP_*`, `SINCLAIR_AGENT_*`)는 그대로 통과
- [ ] 헬퍼 APK 는 리포 빌드에서 복사하고 없으면 조립이 실패한다(빌드 절차 안내 메시지). `.sha256` 사이드카를 함께 만든다
- [ ] 테스트: 호스트 타깃 배포본을 임시 디렉터리에 풀어 실행 스크립트로 서버 기동(READY, sqlite 기본) → `sinclair-agent run --engine fake` → `GET /cycles/:id` verified → 서버 SIGTERM 정상 종료. 기기 없이 `--engine mobile` 은 "기기 없음" blocked(2) 로 끝난다(USB 로드 성공 확인)
- [ ] 배포본 크기·구성 목록을 README 에 적고, 서명이 없다는 점과 macOS 격리 속성 제거(`xattr -dr com.apple.quarantine`) 절차를 쓴다
