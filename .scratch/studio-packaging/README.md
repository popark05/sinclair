# Studio 패키징 (설치본 · URL 스킴)

리포 없이 설치해 쓰는 Sinclair Studio(mac). Windows 는 미룸(2026-11-14 결정).

## 결정 (2026-11-15)

- 패키저: electron-builder(EverMock 과 같은 방식). 서명·공증 없음(사내 QA, 첫 실행 Gatekeeper 우회). mac arm64·x64 DMG + zip.
- 앱 안에 워크스페이스 node_modules 를 넣지 않는다: 메인은 워크스페이스를 런타임 import 하지 않고(guard 테스트), 렌더러는 vite 번들, 작업 프로세스는 esbuild 단일 번들. 런타임 의존은 `usb`(네이티브)만 — 작업 프로세스 옆 node_modules.
- 작업 프로세스는 plain Node(ADR 0005): 고정 버전 Node(`scripts/dist.mjs` NODE_VERSION, 같은 fetchNode)를 `Contents/Resources/node/node` 로 동봉. asar 밖(plain Node 는 asar 를 못 읽음).
- 헬퍼 APK 는 `Resources/helper/` 에 동봉. iOS 러너 빌드는 동봉하지 않는다(사용자 팀 서명이 필요) — `SINCLAIR_IOS_XCTESTRUN`.
- 환경: Finder 로 띄운 앱은 셸 환경변수가 없다. `~/.config/sinclair/env`(또는 `SINCLAIR_ENV_FILE`)의 `KEY=VALUE`(`export` 허용) 중 허용한 이름(`ANTHROPIC_*`, `SINCLAIR_*`, `NODE_EXTRA_CA_CERTS`)만 작업 프로세스에 싣는다. 프로세스 환경이 이긴다. 새 키 저장소는 만들지 않는다.
- URL 스킴 `sinclair://open?request=<id>`: Console 'Studio 에서 열기' 가 중계 요청을 남긴 뒤 이 URL 을 연다 → Studio 가 창을 앞으로 가져오고 그 요청을 곧바로 받는다(데이터는 여전히 control-plane 중계 하나 — URL 에는 id 만).

## 티켓

01 작업 프로세스 번들·설치본 자산 해석(Node·usb·헬퍼 APK·env 파일) / 02 electron-builder 조립(`pnpm dist:studio`) / 03 URL 스킴 / 04 설치본 검증(리포 밖 복사본, Playwright executablePath, 실기)
