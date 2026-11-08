# 01: esbuild 단일 파일 번들 — 리포 밖에서도 두 앱이 돈다

**What to build:** `pnpm bundle` 이 control-plane 과 runner-agent 를 각각 자기완결 CommonJS 파일 하나로 만들고, 그 파일을 리포 체크아웃이 아닌 임시 디렉터리에 복사해 일반 Node(변환 플래그 없음)로 실행하면 `--help`, 서버 READY, ingest, `sinclair-agent run --engine fake` 가 그대로 동작한다. 헬퍼 APK 기본 경로·번들 리소스 디렉터리 같은 자산 경로는 소스 트리가 아니라 "실행 파일 옆 `resources/`" 를 가리킨다. EverMock 의 proxy-worker 번들과 같은 접근(네이티브 `usb` 만 external, `node:*` 내장).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 번들 스크립트가 두 앱을 `dist/<app>/index.cjs` 로 만들고, 새 의존성이 `__dirname`/`import.meta.url` 로 파일을 읽으면 빌드가 실패하거나 테스트가 잡는다(EverMock `proxy-worker-bundle` 테스트 패턴)
- [ ] 자산 경로 해석이 "실행 파일 옆 `resources/`" 우선, 리포 체크아웃(개발)일 때만 소스 트리 fallback. 헬퍼 APK 기본 경로(device-layer)와 번들 디렉터리(runner-agent)가 이 규칙을 따른다
- [ ] bin 셸이 번들이 있으면 변환 플래그 없이 번들을 실행하고, 없으면 지금처럼 `.ts` 를 재실행한다(개발 편의 유지). IPC 고아 방지·신호 전달은 그대로
- [ ] 테스트: 번들을 리포 밖 임시 디렉터리에 복사해 자식 프로세스로 control-plane(`--help`, READY, ingest, sqlite 재기동)과 agent(`run --engine fake` → Cycle verified, `resume --help`)를 돌린다. `node_modules` 없이 돈다는 것이 핵심
- [ ] `usb` 가 external 로 남아 번들 옆 `node_modules/usb` + 플랫폼 패키지로 해석되는 구조를 테스트가 확인한다(기기 없는 환경에서는 `usb` 로드만)
