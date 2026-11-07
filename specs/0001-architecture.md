# 0001. 전체 아키텍처

- 상태: 초안
- intent: intent/0001-sinclair-e2e-platform.md

## 레이어

1. **디바이스 레이어** (`packages/device-layer`): mobilecli 스타일 JSON-RPC 서버. Android는 접근성 헬퍼(artemis 방식, UiAutomation 비독점) + 입력 주입, iOS는 usbmux/go-ios 방식 + XCUITest 러너. 메서드 명명은 `device.io.tap`, `device.dump.ui` 계열. UI 트리는 `ScreenElement` + `@ref`.
2. **엔진** (`packages/engine-mobile`): 러너의 `Engine` 계약(observe/locate/perform + 선택 메서드) 구현. 구현한 메서드로 capability 결정. locator 해석의 모바일 세부(testId가 identifier/resourceId/Flutter key 매칭, bounds 기반 체이닝 fallback, 두 번 연속 같은 bounds일 때 actionable)는 mobilewright 참고.
3. **러너** (`packages/runner`): e2e 구조. 세 동사 분리(결정적 `screen` locator, 계획형 `agent.act`, 판정 `agent.assert/waitFor/extract`). 워커는 타깃당 1개, 실패 후 교체. 녹화 캐시는 검증 통과 후에만 기록, descriptor로 재탐색, 실패 시 스텝 중간부터 에이전트 이어받기, CI는 strict/read-only.
4. **에이전트**: 툴 루프 + artemis의 액션 전 안전망(XML 가중치 재탐색, 픽셀/VLM 비교), Incident 복구, Ledger 컨텍스트 관리. 닫힌 툴 스키마, secure 필드 redaction.
5. **백엔드** (`apps/control-plane`, `apps/runner-agent`): 아래 도메인 모델.
6. **프런트엔드** (`apps/studio`, `apps/console`, `packages/ui`).

## 백엔드 도메인 모델

Suite, TestCase(안정 ID), Cycle(빌드 + 기기 매트릭스 + Suite 필터), Run(Cycle × 타깃), Attempt(테스트 1건 시도; passed/failed/blocked/skipped + 에러 코드 + 캐시 결정), StepRecord, Artifact, Verdict, Issue(app-bug/test-bug/flaky/env, waive), Device(idle/leased/offline/untrusted), CacheEntry.

흐름: Cycle 생성 → Scheduler가 Run 생성·기기 lease → Runner Agent가 러너 실행, 커스텀 Reporter가 이벤트를 Ingest로 스트리밍(멱등) → 재시도 정책 → Cycle 종료 시 Verdict 계산·알림.

Run 클레임(최소 Scheduler, 2026-11-08 runner-agent 티켓 04): Run 은 `POST /cycles/:id/runs` 로 미리 등록되고, 에이전트가 `POST /runs/claim {targetId, agentId}` 로 "등록됐고 이벤트가 없으며 lease 가 없거나 만료된" Run 을 등록 순서로 하나 받는다(**Run lease**: `{agentId, expiresAt}`, TTL 기본 60초, `POST /runs/:id/heartbeat` 로 소유자만 연장, 에이전트는 TTL/3 마다). 이벤트가 하나라도 들어간 Run 은 에이전트가 죽어도 재클레임하지 않는다(부분 보고 run 의 재실행은 재시도 정책에서). 에이전트가 run 도중 lease 를 잃으면 heartbeat 를 멈추고 경고하되 run 은 끝까지 돌아 같은 runId 로 보고된다(러너는 테스트 중간 중단을 지원하지 않음; 알려진 한계). **기기 lease**(Device idle/leased)는 아직 없다 — 에이전트가 자기 기기를 안다는 전제. Cycle 의 Suite 필터는 `suite: { tests, tags? }` 로 저장되며 에이전트는 `tests` 디렉터리를 쓴다(`tags` 는 저장만, 필터링은 후속).

Reporter 계약(러너 `Reporter`, 2026-11-07 티켓 control-plane-ingest 01/03): `onEvent(event)` 는 발생 즉시 불리고 테스트 실행을 막지 않는다. run 끝에 `flush()` 를 기한(`reporterFlushTimeoutMs`) 안에서 기다리고, 그 뒤 `close()` 로 재시도를 멈춘다. Reporter 가 알리고 싶은 문제는 `warnings` 로 노출하고 러너가 `RunReport.warnings` 에 합친다. HTTP Reporter 는 5xx·408·429·연결 오류를 같은 eventId 로 재시도(Ingest 멱등), `rejected[]`·그 밖의 4xx 는 경고, 413 은 배치를 쪼개 재전송한다. 서버가 영구 다운이면 flush 기한 뒤 close 가 남은 큐를 버리고 경고한다(디스크 스풀은 runner-agent 몫).

Verdict 규칙: TestCase × 타깃 최종 상태 = 마지막 Attempt. 재시도로 통과하면 `passed(flaky)`. 필수 태그 전부 통과해야 `verified`, 아니면 `blocked`. waive된 Issue는 제외.

Verdict 세부(2026-11-07, control-plane-ingest 티켓 05, `apps/control-plane/src/verdict.ts`): 마지막 Attempt 는 `attemptNo` 최대(끝난 것만). 케이스 집합은 Cycle 의 run 들이 본 testId 합집합. 어떤 타깃의 run 에 없는 케이스는 그 run 이 `infra-failed`/`cancelled` 면 `blocked`, `finished` 면 `skipped`. 태그는 TestCase 레지스트리가 생기기 전까지 테스트 이름의 `@태그` 토큰(e2e/Playwright 관례)이고 `requiredTags` 가 비면 모든 케이스가 필수. Cycle 상태는 run 없음 `draft`, 미종료 run 있음 `running`, 전부 종료 `finished`. Cycle Verdict 는 미종료면 `incomplete`, 모든 Run 이 `finished` 로 끝나고 필수 케이스 × 모든 타깃이 passed/passed-flaky/waived 면 `verified`, 아니면 `blocked`(infra-failed/cancelled Run 이 하나라도 있으면 케이스를 몰라도 blocked). 같은 타깃에 Run 이 여럿이면 뒤에 등록된 Run 의 결과가 앞을 덮는다(재실행). Verdict 는 저장하지 않고 조회마다 다시 계산한다(늦게 도착한 이벤트가 반영된다); 대신 끝난 Cycle 에는 Run 을 더 등록할 수 없다(409). `run.started` 에는 러너를 돌린 노드의 `agentId`(선택)가 실린다. `run.started` 의 cycleId/targetId 가 등록과 다르면 판정은 등록을 따르고 조회 응답의 `warnings` 로 드러낸다. `expired`/`cancelled` 는 Scheduler 가 생기기 전까지 쓰이지 않고, `waived` 는 Issue/waive 가 생기기 전까지 생성되지 않는다. Cycle 과 Run 등록은 이벤트가 아닌 레코드(`CycleStore`)로 저장한다. 

## 프런트엔드

- **Studio** (Electron): Device 패널(라이브 스트림, 입력 전달), Inspector(트리 + locator 후보 생성), Agent Session(턴 타임라인, 지시 주입), Recording 편집·코드 내보내기, Test Editor(Monaco), Network(EverMock 연동), Trace Viewer.
- **Console** (웹): Cycle 매트릭스 히트맵, Verdict, 실패 상세·공유 링크, Issue 분류, 안정성 이력, 플릿 상태, 비용·캐시 적중률.
- 둘은 `packages/ui`를 공유.

## 네트워크 모드

직접(기본, 프록시 없음) / 캡처(패스스루 + 기록) / Mock(EverMock 시나리오). `mock` fixture를 쓰는 테스트만 프록시 활성화. 프록시 모드는 CA 미신뢰 기기를 `blocked` 처리.

## EverMock과의 관계

별도 앱 유지. 디바이스 레이어를 공유 패키지로 분리해 하나의 데몬이 기기를 소유한다. Studio는 EverMock의 프록시 워커·시나리오 라이브러리를 fixture로 호출한다.

## 첫 구현 단위

`packages/protocol`: Run/Attempt 상태, 이벤트 스키마, 엔진 계약 타입, 디바이스 JSON-RPC 메서드 이름. 계약 테스트 포함.
