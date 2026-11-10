---
name: verify-console
description: "Sinclair Console(apps/console 웹 대시보드)이 실제 control-plane 이 서빙하는 상태에서 Cycle 목록·매트릭스·케이스 상세·플릿·안정성 이력 화면을 끝까지 그리는지 헤드리스 Chrome 으로 증명한다. Console 화면·API 클라이언트·control-plane 의 Console 표면(/cycles/summary, /cycles/:id/usage, /tests/history, /console 정적 서빙)을 바꿨을 때, 또는 'Console 이 실제로 열리는지 보여 달라'는 요청에 쓴다."
---

# verify-console

Console 은 React + Vite 정적 앱이고 control-plane 이 `--console-dir`(설치본은 동봉한 `resources/console`)로 `/console` 에서 서빙한다. 컴포넌트 테스트(`apps/console/test`, 가짜 API)는 `pnpm test` 가 한다. 이 스킬은 **실제 서버 + 실제 브라우저** 로 사용자 경로를 본다.

## Launch

전제: Google Chrome(macOS 기본 경로, 아니면 `CHROME` 환경변수), Node 22.18+.

```bash
node .claude/skills/verify-console/scripts/verify.mjs          # Console 빌드 → control-plane(메모리, TTL 8초) → 가짜 에이전트 run → 노드 보고 → 화면 6개 + 아티팩트·노드 삭제 API (약 30초)
node .claude/skills/verify-console/scripts/verify.mjs --no-build
```

준비 완료 기준: control-plane 이 `READY … port=` 를 찍고, 에이전트가 종료 코드 1(통과 1·실패 1)로 끝난다.

## Drive

- 데이터: Cycle `verify-<시각>`(빌드 `verify-1.0`, 타깃 android)에 `sinclair-agent run --engine fake --tests apps/runner-agent/test/fixtures`(통과 1·실패 1), 노드 `verify-node` 의 가짜 기기 보고(`PUT /fleet/nodes/verify-node`), 노드 TTL(8초)이 지나 끊긴 노드 `verify-gone`.
- 화면: `/console/`(목록), `/console/cycles/<id>`(매트릭스·Run), 실패 케이스 상세, `/console/fleet`, `/console/tests`. Chrome `--headless=new --dump-dom --virtual-time-budget=8000` 로 렌더된 DOM 을, `--screenshot` 으로 그림을.
- 판정: 화면마다 기대 문구가 DOM 에 있고 `role="alert"`(불러오기 실패)가 없을 것.

## Evidence

- `.scratch/console/evidence/verify-console-latest.json`(리포에 남음): 화면별 경로(Cycle id 는 `<cycle>`)·기대 문구 판정·스크린샷 크기. 가짜 엔진·가짜 기기라 개인정보 없음.
- `.e2e/verify-console/<화면>.png`(git-ignore): 스크린샷. 사람이 눈으로 한 번 본다(색·배치).

## Cleanup

스크립트가 control-plane 을 SIGTERM 으로 끄고 임시 디렉터리(스풀·Chrome 프로필)를 지운다.

## Helpers

| 경로 | 역할 |
| --- | --- |
| `scripts/verify.mjs` | 빌드·서버·데이터·브라우저·증거 한 번에 |
| `apps/console/test/*.test.tsx` | 화면별 컴포넌트 테스트(가짜 API) |
| `apps/control-plane/test/console-http.test.ts`, `usage-history-http.test.ts` | control-plane 의 Console 표면 |

## 검증 이력

- 2026-11-10: 노드 정리(followups 06) — 서버를 `--lease-ttl-ms 8000` 으로 띄워 끊긴 노드 `verify-gone` 을 만들고, 플릿에 끊김·지우기 버튼이 보이는지, `DELETE /fleet/nodes/:agentId` 가 끊긴 노드 204·온라인 노드 409 인지 확인(검사 8개). Chrome 을 동기로 부르는 동안 유휴 keep-alive 소켓이 닫혀 다음 요청이 ECONNRESET 나는 스크립트 문제를 한 번 재시도로 막음.
- 2026-11-10: Issue 화면(followups 04) 추가 — 검사 7개.
- 2026-11-10: 아티팩트 업로드(followups 01) — 에이전트가 올린 실패 스크린샷을 서버가 주고 케이스 상세가 그림·트리 링크로 보이는지 확인(검사 6개).
- 2026-11-10: 최초 시드(console 07). 화면 5개 PASS. 처음 실행에서 Run 행의 노드가 비는 것(lease 없이 보고된 Run)을 잡아 Cycle 뷰의 Run 행에 이벤트의 agentId·deviceId 를 싣도록 고쳤다.
