# 01: Electron 골격 — astryx ide 레이아웃과 작업 프로세스

**What to build:** electron-vite 로 `apps/studio`(main·preload(CJS)·renderer) 를 세우고, 렌더러는 astryx `ide` 템플릿에서 시작해 spec 의 4영역(기기·탭·Inspector·로그 드로어) 빈 레이아웃과 neutral 테마를 그린다. 메인은 plain Node 작업 프로세스(ADR 0005)를 띄워 ping/pong IPC 계약 하나를 통과시킨다.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] electron-vite 설정, `pnpm --filter @sinclair/studio dev`·`build`, typecheck
- [ ] astryx: reset.css·astryx.css, `astryx theme add neutral`, `ide` 템플릿 스캐폴드 → 4영역, `astryx doctor --built` 통과
- [ ] IPC 계약 단일 정의(`studio-ipc.ts`: 채널·메시지 타입) + preload 노출 + 작업 프로세스 fork(고정 Node 해석은 runner-agent 와 같은 규칙)
- [ ] 테스트: IPC 계약(타입·직렬화), 작업 프로세스 ping 왕복, 렌더러 레이아웃 스모크(jsdom)
