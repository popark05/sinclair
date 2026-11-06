# CLAUDE.md

## 프로젝트

Sinclair: 모바일(iOS/Android)과 웹 앱을 위한 에이전트 기반 E2E 검증 플랫폼. 자연어로 목표를 주면 에이전트가 앱을 조작해 결정적 테스트 스크립트로 굳히고, 테스트 사이클 단위로 결과를 취합해 검증 현황을 관리한다. 사내 QA용이며 코드 주석, UI 문자열, 커밋 메시지는 한국어로 쓴다.

`reference/` (git-ignored)에는 참고용 외부 프로젝트가 있다. **설계와 패턴만 참고하고 코드를 `apps/`, `packages/`로 복사하지 않는다.**

- `reference/e2e` (Apache-2.0): 러너, 테스트 API, 녹화·재생 캐시, 엔진 계약의 기준.
- `reference/artemis` (Apache-2.0): 에이전트 루프의 안전망, Incident 복구, 컨텍스트(Ledger) 관리, 접근성 헬퍼 APK.
- `reference/mobilenext`: 디바이스 JSON-RPC 표면과 스트리밍 설계. **mobilecli, devicekit-*은 FSL-1.1 라이선스**라 프로토콜 설계만 참고한다. mobilewright, mobile-mcp, react-device-view는 Apache-2.0.

## 명령

```bash
pnpm install
pnpm typecheck        # 모든 워크스페이스 tsc --noEmit
pnpm test             # vitest (packages/*/test, apps/*/test)
pnpm lint             # oxlint
pnpm check            # lint + typecheck + test
npx vitest run packages/protocol   # 단일 패키지
```

사내망(SSL 인터셉션)에서는 `export NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem` 후 설치한다.

## 구조

```
intent/         Plan 단계 산출물 (intent.md). 문제, 사용자, 제약, 성공 기준
specs/          Design 단계 산출물 (spec.md). 계약·타입·결정이 여기서 확정됨
docs/adr/       아키텍처 결정 기록
docs/glossary.md 용어집
evals/          에이전트 설정(CLAUDE.md, 스킬, hooks) 회귀용 eval 정의
packages/
  protocol/     이벤트 스키마, Run/Attempt 상태, 디바이스 JSON-RPC 타입, 엔진 계약 타입. 다른 패키지가 모두 의존
  device-layer/ 디바이스 JSON-RPC 서버 (adb/usbmux + 온디바이스 에이전트)
  engine-mobile/ 러너 엔진 계약의 모바일 구현 (device-layer 위)
  runner/       테스트 러너: locator/expect, agent.act/assert, 녹화·재생 캐시, 리포터
  ui/           공유 React 컴포넌트: device-view, trace-viewer, tree-inspector
apps/
  studio/       Electron 데스크탑 앱 (테스트 작성·디버깅, 라이브 기기 뷰)
  console/      웹 대시보드 (Cycle 매트릭스, Verdict, 이력)
  control-plane/ API 서버 (Cycle/Run/Attempt, Ingest, Fleet, 원격 캐시)
  runner-agent/ 워커 데몬 (기기 연결 노드에서 러너 실행, 이벤트 스트리밍)
```

의존 방향은 `protocol ← device-layer ← engine-mobile ← runner ← apps`. 역방향 import 금지.

## 핵심 설계 결정 (상세는 specs/)

- 테스트 스크립트 형식과 러너는 e2e 방식(`test`/`expect`/`screen.getByRole`, `agent.act`/`assert`). mobilewright는 locator 해석의 모바일 세부 구현만 참고.
- 녹화 캐시는 검증(assert)이 통과한 뒤에만 기록, 의미 기반 descriptor로 재탐색, 실패 시 에이전트가 스텝 중간부터 이어받음.
- 네트워크 모킹은 EverMock을 `mock` fixture로 불러 쓴다. 기본은 Mock 없는 직접 모드.
- EverMock은 별도 앱으로 유지. 디바이스 레이어는 공유 패키지로 뽑아 하나의 데몬이 기기를 소유한다.

## 작업 방식 (AI-Native SDLC)

Plan(`intent/`) → Design(`specs/`, `/architect`로 타입 먼저) → Build(`to-tickets` → `implement`, `tdd`) → Test(검증 스킬, evals) → Deploy(`code-review`, `/interrogate`, `REVIEW.md`) → Maintain(`retro`, `/reflect`, 실패는 새 intent로).

- 계약(엔진 인터페이스, 이벤트 스키마, JSON-RPC)을 바꾸면 반드시 `packages/protocol`의 계약 테스트를 먼저 갱신한다.
- 버그는 실패하는 테스트를 먼저 커밋한 뒤 고친다.
- 반복된 실수는 아래 "알려진 실수" 절에 추가한다.

## 알려진 실수

(아직 없음)
