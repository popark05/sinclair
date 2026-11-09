# 01: Console 골격 + Cycle 목록 — 릴리즈 담당이 브라우저에서 Cycle 들의 상태를 본다

**What to build:** `apps/console`(React + Vite)이 control-plane HTTP API 만으로 Cycle 목록(빌드·상태·Verdict·진행률·생성 시각)을 보여 준다. control-plane 은 `--console-dir`(또는 환경변수)로 받은 빌드 결과를 `/console` 에서 정적으로 서빙한다 — apps 끼리 런타임 import 없음.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Vite + React + TS 앱, `pnpm --filter @sinclair/console build` 로 정적 산출물. 개발 서버는 control-plane 으로 프록시
- [x] 타입 있는 API 클라이언트(GET /cycles, /cycles/:id, /runs/:id, /fleet) — 응답 모양은 control-plane 타입과 맞춘다(apps 끼리 import 없이)
- [x] Cycle 목록: 최신순, 상태·Verdict 배지, 진행률(끝난 Run/전체), 오류 시 분명한 안내
- [x] control-plane 정적 서빙(`/console`, SPA 경로는 index.html, 경로 탈출 거부), 옵션 없으면 꺼짐
- [x] 테스트: 컴포넌트(가짜 API) + control-plane 정적 서빙

## Comments

- 2026-11-09 구현(seam 3개 승인, React + Vite): `apps/console`(Vite 7.3.7, React 19.1.1, `base: /console/`), API 클라이언트 `createApi`(응답 타입은 `@sinclair/control-plane` 에서 type 으로만 — devDependency, 런타임 import 없음), 작은 경로 라우터(`/console/cycles/:id` 공유 링크), Cycle 목록(최신순·상태·Verdict 배지·진행률·빈 목록·오류 안내).
- control-plane: `GET /cycles/summary?limit=N`(1~500, 기본 50, 최신순, 진행률은 대체되지 않은 Run 기준 — "summary" 라는 cycleId 는 쓸 수 없다), `--console-dir`/`SINCLAIR_CP_CONSOLE_DIR` 로 `/console` 정적 서빙(확장자 없는 경로는 index.html, 없는 자산 404, 경로 탈출 거부, index.html 은 no-cache·자산은 immutable, `/` → `/console/`), 옵션이 없으면 API 만.
- 루트 vitest 가 `*.test.tsx` 와 JSX 자동 런타임을 받는다. 빌드는 `pnpm --filter @sinclair/console build`(→ `apps/console/dist`), 개발은 `pnpm --filter @sinclair/console dev`(API 를 `SINCLAIR_CONSOLE_API`, 기본 127.0.0.1:4780 으로 프록시).
- 실제 확인: control-plane bin 을 `--console-dir apps/console/dist` 로 띄워 `/` 302, `/console/cycles/demo` 200 html, 자산 200 javascript, `/cycles/summary` 확인.
