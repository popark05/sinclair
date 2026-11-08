# 01: esbuild 단일 파일 번들 — 리포 밖에서도 두 앱이 돈다

**What to build:** `pnpm bundle` 이 control-plane 과 runner-agent 를 각각 자기완결 CommonJS 파일 하나로 만들고, 그 파일을 리포 체크아웃이 아닌 임시 디렉터리에 복사해 일반 Node(변환 플래그 없음)로 실행하면 `--help`, 서버 READY, ingest, `sinclair-agent run --engine fake` 가 그대로 동작한다. 헬퍼 APK 기본 경로·번들 리소스 디렉터리 같은 자산 경로는 소스 트리가 아니라 "실행 파일 옆 `resources/`" 를 가리킨다. EverMock 의 proxy-worker 번들과 같은 접근(네이티브 `usb` 만 external, `node:*` 내장).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 번들 스크립트가 두 앱을 `dist/<app>/index.cjs` 로 만들고, 새 의존성이 `__dirname`/`import.meta.url` 로 파일을 읽으면 빌드가 실패하거나 테스트가 잡는다(EverMock `proxy-worker-bundle` 테스트 패턴)
- [x] 자산 경로 해석이 "실행 파일 옆 `resources/`" 우선, 리포 체크아웃(개발)일 때만 소스 트리 fallback. 헬퍼 APK 기본 경로(device-layer)와 번들 디렉터리(runner-agent)가 이 규칙을 따른다
- [x] bin 셸이 번들이 있으면 변환 플래그 없이 번들을 실행하고, 없으면 지금처럼 `.ts` 를 재실행한다(개발 편의 유지). IPC 고아 방지·신호 전달은 그대로
- [x] 테스트: 번들을 리포 밖 임시 디렉터리에 복사해 자식 프로세스로 control-plane(`--help`, READY, ingest, sqlite 재기동)과 agent(`run --engine fake` → Cycle verified, `resume --help`)를 돌린다. `node_modules` 없이 돈다는 것이 핵심
- [x] `usb` 가 external 로 남아 번들 옆 `node_modules/usb` + 플랫폼 패키지로 해석되는 구조를 테스트가 확인한다(기기 없는 환경에서는 `usb` 로드만)

## Comments

- 2026-11-08: 완료. `scripts/build-bundles.mjs`(`pnpm bundle`): esbuild **ESM + 코드 스플리팅** 한 번에 `dist/control-plane.mjs`, `dist/runner-agent.mjs`, `dist/runner.mjs`(테스트 파일용 공개 API) + 공유 `chunk-*.mjs`(protocol·runner 단일 인스턴스라 `instanceof EngineError`·`test()` 레지스트리가 하나) + `dist/hooks.mjs`(node:module resolve 훅: 테스트 파일의 `@sinclair/runner` → `runner.mjs`). `usb` 만 external(이미 지연 import). esbuild `define` 으로 `process.env.SINCLAIR_BUNDLED='1'`. 가드: 번들에 리포 절대 경로가 남으면 빌드 실패. 엔트리 `apps/*/src/cli.ts`(에이전트는 번들일 때 훅 등록). 자산 경로: `resources.ts` `resourcesDir()` = `SINCLAIR_RESOURCES_DIR` → 번들 `<dist>/../resources` → 개발 `apps/runner-agent/resources`; 리포 디버그 빌드 fallback 은 번들에서 비활성; device-layer 기본 APK 는 개발 전용 지연 계산(번들은 undefined). bin 셸은 `src/main.ts` 가 없는 설치 배치에서만 `dist/<app>.mjs` 를 실행(리포에서는 항상 .ts). 테스트 `bundle.test.ts`: 임시 디렉터리에 빌드 → node_modules 없이 control-plane(--help, sqlite READY/ingest/재기동), agent(`run --engine fake` 가 훅으로 해석한 `.ts` 테스트 파일을 돌려 verified, `resume --help`, 모르는 명령 3), 자산 경로(`--engine mobile` + APK 없음 → 사유에 `<설치>/resources/helper` 경로, USB 전 실패). esbuild 를 루트 devDependency 로 명시.
- 결정: 티켓의 "CJS 한 파일" 대신 ESM+스플리팅(중복 인스턴스 문제를 훅 없이 해결). 사용자 테스트 파일(`.sinclair.ts`)은 Node 의 네이티브 타입 스트리핑에 의존(Node 24 기본; 22.13~22.17 은 `--experimental-strip-types` 필요 → 02 의 고정 Node 는 24 계열). `usb` 는 번들 옆 `node_modules/usb` 로 해석(02 가 넣는다).
- 2026-11-08 리뷰 반영(Standards + Spec): (1) `resources.ts` 의 동일 분기 삼항 제거 — 규칙을 "이 모듈의 형제 `resources/`" 한 식으로 쓰고 두 배치(설치본 `dist/..`, 개발 `src/..`)가 같은 모양임을 주석으로. 미사용 매개변수 삭제. (2) 가드 강화: 리포 절대 경로 + `__dirname`/`__filename`(ESM 에서 ReferenceError) + `import.meta.url` 사용처 수를 허용 목록(4곳, 사유 포함)과 비교 — 새 파일 자산 참조가 생기면 빌드 실패(EverMock 가드와 같은 목적). 실제로 처음 돌릴 때 빠뜨린 한 곳을 잡아냈다. (3) 훅을 문자열 대신 실파일 `apps/runner-agent/src/hooks.mjs`(lint 대상)로 두고 복사. (4) device-layer 가 앱 빌드 define(`SINCLAIR_BUNDLED`)을 읽던 결합 제거 — 번들에서는 개발 경로가 존재하지 않아 자연히 "APK 없음". (5) `engines.node >= 22.18`(네이티브 타입 스트리핑), 에이전트 도움말·CLAUDE.md·ADR 0004 에 Node 요구와 새 명령(`pnpm bundle`)·환경변수 기록, 번들 테스트는 22.18 미만이면 skip. (6) bin 셸 번들 모드 주석(자식 없음, IPC 해당 없음). (7) 02 티켓에 설치 레이아웃 계약(dist 한 디렉터리, `<install>/resources/helper`, `<install>/node_modules/usb` + 플랫폼 패키지, Node 24 런처) 명시. 미반영: `usb` 가 번들 옆 node_modules 에서 실제로 로드되는 것은 02 의 "기기 없음 blocked(2)" 테스트에서 확인(01 은 import 문 존재만).
