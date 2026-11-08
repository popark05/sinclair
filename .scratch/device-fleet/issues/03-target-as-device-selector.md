# 03: 타깃 = 기기 선택 조건 — Cycle 매트릭스 열이 조건에 맞는 아무 기기로 채워진다

**What to build:** Cycle 을 만들 때 타깃을 이름과 기기 선택 조건(플랫폼, 모델, OS 버전 범위)으로 정의한다. 클레임은 내놓은 idle 기기 중 그 조건에 맞는 기기가 있을 때만 그 타깃의 Run 을 준다. 매트릭스 열은 지금처럼 타깃 이름이고, 셀마다 실제로 돈 기기가 보인다. 데몬은 더 이상 `--targets` 로 맡을 타깃을 선언하지 않아도 된다(조건이 정한다).

**Blocked by:** 02 (클레임 때 기기 lease)

**Status:** ready-for-human

- [x] 조건 형식: 플랫폼(필수), 모델(선택, 정확히 일치 또는 목록), OS 버전 범위(선택, 최소·최대). 잘못된 조건은 `POST /cycles` 400. 형식은 계약이므로 protocol 계약 테스트를 먼저 갱신
- [x] 하위 호환: 문자열 타깃(`android`)은 "그 이름을 맡겠다고 선언한 노드" 규칙으로 계속 동작(데몬 `--targets`). 새 조건 타깃과 섞인 Cycle 도 허용할지 결정하고 명시
- [x] 클레임 매칭: 조건에 맞는 기기가 여럿이면 고르는 규칙(예: 오래 쉰 기기 먼저)을 정하고 테스트. 맞는 기기가 없으면 Run 은 대기(blocked 아님)
- [x] Cycle 뷰: 타깃 정의(조건)와 셀·run 행의 기기(마스킹). 같은 타깃의 Run 이 다른 기기에서 대체되면 대체 사슬에 기기도 보인다
- [x] GLOSSARY 의 "타깃" 정의 갱신 확인, spec 0001 에 조건 형식·매칭 규칙
- [x] 테스트: Android 13 이상 조건 타깃 + Android 12·13 기기 → 13 기기만 클레임, 모델 지정 타깃, 조건에 맞는 기기 없음 → 대기

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 seam: (1) protocol `TargetSelector`·`parseCycleTargets`(닫힌 검증기)·`matchesTarget`·`compareOsVersion`(점으로 나눈 숫자, 13 < 13.1 < 14), 계약 테스트 먼저, (2) Cycle 은 이름·조건 타깃을 섞어 받는다(`targetSelectors`), 같은 이름 문자열은 예전처럼 합치고 조건이 낀 중복은 거부, 셀에 돈 기기(`deviceId`), (3) `targetId` 없는 클레임 `{agentId, devices, targets?}`: 이름 타깃은 선언했을 때, 조건 타깃은 빈 후보 중 맞는 기기가 있을 때(속성은 Fleet 보고, 보고 안 한 기기는 조건 타깃을 못 받음), 맞는 기기가 여럿이면 가장 오래 쉰 기기 먼저(lease `claimedAt`), 맞는 기기가 없으면 다음 Run 을 본다(대기), 기존 `targetId` 클레임은 그대로(조건 타깃이면 기기가 맞아야 함), (4) 데몬은 폴링마다 클레임 한 번, `--targets` 선택, (5) 증명.
- 저장소: `claimRun(targetId?, …, { eligible })` — eligible 은 비동기라 SQLite 트랜잭션 밖에서 부르고, 트랜잭션 안에서는 허용 기기 중 빈 기기를 고른다. 이 Run 에 맞는 빈 기기가 없으면 반환하지 않고 다음 Run 으로(예전에는 즉시 undefined).
- 테스트: protocol 계약 8개, HTTP 5개(섞인 타깃·400, Android 13 이상 → 13 기기만·없으면 대기, 모델 지정·이름 타깃은 선언 시만·보고 안 한 기기 거부, 오래 쉰 기기 먼저·셀 deviceId, targetId 클레임도 조건 확인), 데몬(--targets 없이 조건 타깃만, 먼저 등록된 안 맞는 Run 은 건너뜀). `fleet.sh` 에 조건 타깃(FakeEngine 모델 → 선언 없이 노드가 받음, OS 99 이상 → 대기), `retry-e2e.sh` 재통과(10/10).
- 실기기에서 발견: 백엔드를 연 직후 첫 기기 목록이 비어(앞 프로세스가 USB 를 막 놓음) "기기 0대" 로 보고되어 꽂힌 기기가 잠깐 offline 으로 보였다 → 첫 읽기에서만 engineFor 와 같은 재시도.
- **남은 것(ready-for-human):** 실기기 조건 타깃 — 재실행 때 폰이 다시 잠겨 있어(게이트가 맞게 동작: 후보에서 뺌, 두 Run 모두 대기) 증명이 끝나지 않았다. 잠금 해제 뒤 `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/selector.device.test.ts`.
