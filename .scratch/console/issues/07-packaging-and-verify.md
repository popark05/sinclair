# 07: 배포·검증 — 설치본에 Console 이 들어 있고 실제로 열린다

**What to build:** `pnpm dist` 설치본이 Console 정적 파일을 동봉하고 control-plane 런처가 기본으로 `/console` 을 서빙한다. `verify-console` 스킬이 실제 control-plane + 가짜 에이전트로 Cycle 을 채우고 헤드리스 브라우저로 목록·매트릭스·상세·플릿 화면을 확인해 증거를 남긴다.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** done

- [x] 번들·설치본에 Console 동봉, 런처 기본 서빙, 기존 dist 테스트 갱신
- [x] `verify-console` 스킬(Launch/Drive/Evidence), 스크린샷·DOM 증거(개인정보 없음)

## Comments

- 2026-11-10 구현: `scripts/dist.mjs` 가 `buildConsole()`(pnpm --filter @sinclair/console build)로 Console 을 한 번 빌드해 설치본 `resources/console/` 에 넣는다(README 에 `/console/` 안내). control-plane 의 `--console-dir` 기본값은 자산 디렉터리(SINCLAIR_RESOURCES_DIR, 없으면 번들 옆 `../resources`)의 `console/index.html` 이 있으면 그것, `none` 이면 끔 — 번들 가드의 `import.meta.url` 허용 목록에 그 사용처를 더했다(가드가 처음에 잡았다). dist 테스트: 구성에 `resources/console/index.html`, 런처가 `--console-dir` 없이 `/console/`·자산을 서빙.
- `verify-console` 스킬: 실제 control-plane + 가짜 에이전트 Cycle + 노드 보고 → 헤드리스 Chrome 으로 화면 5개(목록·매트릭스·케이스·플릿·이력) DOM 판정과 스크린샷. 2026-11-10 5/5 PASS(`.scratch/console/evidence/verify-console-latest.json`).
- 스킬이 잡은 결함: Cycle 뷰의 Run 행이 노드·기기를 lease 에서만 읽어 `sinclair-agent run`(lease 없음) Run 은 '—' 였다 → control-plane Cycle 뷰의 runs 에 이벤트의 `agentId`·`deviceId` 를 싣고 Console 은 lease 다음으로 그것을 쓴다(계약 테스트 추가).
