# 01: Electron 골격 — astryx ide 레이아웃과 작업 프로세스

**What to build:** electron-vite 로 `apps/studio`(main·preload(CJS)·renderer) 를 세우고, 렌더러는 astryx `ide` 템플릿에서 시작해 spec 의 4영역(기기·탭·Inspector·로그 드로어) 빈 레이아웃과 neutral 테마를 그린다. 메인은 plain Node 작업 프로세스(ADR 0005)를 띄워 ping/pong IPC 계약 하나를 통과시킨다.

**Blocked by:** None

**Status:** done

- [x] electron-vite 설정, `pnpm --filter @sinclair/studio dev`·`build`, typecheck
- [x] astryx: reset.css·astryx.css, `astryx theme add neutral`, `ide` 템플릿 스캐폴드 → 4영역, `astryx doctor --built` 통과
- [x] IPC 계약 단일 정의(`studio-ipc.ts`: 채널·메시지 타입) + preload 노출 + 작업 프로세스 fork(고정 Node 해석은 runner-agent 와 같은 규칙)
- [x] 테스트: IPC 계약(타입·직렬화), 작업 프로세스 ping 왕복, 렌더러 레이아웃 스모크(jsdom)

## Comments

- 2026-11-14 구현. electron 45.2.0·electron-vite 6.0.0·vite 7.3.7·@vitejs/plugin-react 5.0.4·@heroicons/react 2.2.0(astryx `ide` 템플릿 아이콘) 고정. `pnpm --filter @sinclair/studio dev|build|start`. main(ESM, `out/main/index.js`)·worker(`out/main/worker.js`, plain Node — 지금은 의존성 없음)·preload(CJS `index.cjs`, 샌드박스·contextIsolation)·renderer(React + astryx).
- 렌더러: `astryx theme add neutral`(모듈을 `src/renderer/src/astryx-themes.ts` 로 옮김 — doctor 통과), `astryx template ide` 를 Studio 4영역으로(틀·크기 조절·접기 유지): 기기(왼쪽 360) · 세션 탭 · Inspector(오른쪽 360) · 로그 드로어(아래 220). `AppShell height="fill"` 로 감싸야 레이아웃이 창 높이를 채운다(루트에 높이가 없으면 내용만큼만 자람 — 실기 캡처로 확인). `astryx doctor --built out/renderer` 12/12.
- IPC 계약 `src/shared/studio-ipc.ts`(채널·메시지·`parseFromWorker`·`StudioApi`), 메인 `worker-host.ts`(fork(execPath=plain Node), 상태 starting→ready→exited, id 로 짝짓기, 죽으면 대기 요청 실패, stop 은 disconnect → 늦으면 SIGKILL), Node 는 `SINCLAIR_STUDIO_NODE` 또는 PATH 의 node(설치본 동봉은 패키징 때).
- 검증 훅: `SINCLAIR_STUDIO_SCREENSHOT=<png>` 면 로드·작업 프로세스 준비 뒤 창을 캡처해 저장하고 끝낸다(verify-studio 용). 실제 Electron 실행 캡처로 4영역·작업 프로세스 준비(Node v24.13.0) 확인.
- 테스트 9개: IPC 계약, 작업 프로세스 왕복·죽음·Node 없음, 렌더러 4영역·상태 표시(jsdom).
