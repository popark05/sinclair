# 05: 기기 상태로 클레임 거르기 — 잠긴·준비 안 된 기기는 Run 을 받지 않는다

**What to build:** 잠긴 기기, 헬퍼가 준비되지 않은 기기, 연결 승인을 안 한 기기는 클레임 후보에서 빠져 Run 이 blocked 로 끝나는 대신 다른 기기를 기다린다. 실행 중에 기기가 빠지거나 잠기면 그 기기는 offline/untrusted 가 되고 run 은 지금 규칙(blocked 또는 버려진 Run)으로 끝난다. QA 담당자는 fleet 에서 "왜 이 기기가 쉬고 있는지"(사유)를 본다.

**Blocked by:** 01 (Fleet 인벤토리), 02 (클레임 때 기기 lease)

**Status:** ready-for-human

- [x] 클레임 직전에 데몬이 후보 기기의 상태를 다시 확인(잠금·헬퍼). untrusted 기기는 내놓지 않고 보고에 사유를 남긴다
- [x] 다시 idle 이 되면(잠금 해제·헬퍼 준비) 다음 보고·클레임부터 후보로 돌아온다. 헬퍼 온보딩은 클레임 전에 끝낸다(첫 run 이 온보딩 때문에 blocked 되지 않게)
- [x] 실행 중 기기 상실: 엔진 오류(device-unavailable)로 run 이 blocked 로 끝나면 그 기기를 offline 으로 표시하고 lease 를 푼다
- [x] 테스트: 잠긴 가짜 기기 + 정상 기기 → Run 은 정상 기기로, 잠긴 기기 해제 뒤 다음 Run 을 받음; 실행 중 기기 상실 → blocked + 기기 offline
- [x] 실기기: 잠긴 상태에서 데몬이 Run 을 받지 않고 fleet 에 사유가 보이며, 잠금 해제 뒤 Run 을 받아 끝냄

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 seam: (1) "쓸 수 있는 기기" 규칙 `nodeDeviceProblem` 을 protocol 로(데몬·control-plane 공유, 계약 테스트), (2) 데몬은 클레임 주기마다 인벤토리를 다시 읽어 쓸 수 있는 기기만 후보로, 뺀 사유는 바뀔 때만 로그, 잠긴 mobile 기기는 한 번 깨우고 스와이프(같은 기기 30초에 한 번), (3) run 이 blocked 로 끝나면 즉시 재보고, (4) 실기기 두 단계.
- 헬퍼 온보딩은 이미 클레임 전에 끝난다: mobile 데몬은 시작 때 백엔드를 열고 인벤토리(listDevices 가 첫 판정·온보딩을 기다림)를 읽은 뒤 클레임한다. 헬퍼가 pending 이면 `헬퍼 준비 안 됨(pending)` 으로 빠진다.
- 테스트: protocol 규칙(문제 없음·모름은 막지 않음·네 사유), 데몬 — 잠긴 기기 + 정상 기기 → Run 은 정상 기기로, 상태가 바뀌면 다음 Run 이 풀린 기기로, 뺀 사유 로그는 바뀔 때만(마스킹), 실행 중 기기 빠짐 → blocked + 곧바로 Fleet offline(보고에서 빠짐).
- 실기기 (A) 잠긴 폰: 데몬이 한 번 깨우고 스와이프했지만 보안 잠금이라 그대로 → "후보에서 뺌: 화면 잠김" 1회, "후보 기기 없음" → Run 은 queued·lease 없음, Fleet untrusted/화면 잠김(`.scratch/device-fleet/evidence/05-locked-device-latest.json`). 02 때는 같은 상황에서 lease 받고 blocked 로 끝났다.
- 실기기 (B) 잠금 해제 뒤(같은 날, 05 코드): 새로 띄운 데몬이 기기를 후보로 내 lease 받아 Run verified → 기기 idle 복귀(`02-device-lease-device-latest.json` 갱신). Spec 리뷰 지적대로 이것은 02 경로라 "제외 → 다시 후보" 전환은 보이지 않는다 — 아래 2단계 테스트로 보완.
- 리뷰 반영(Standards + Spec). (1) **must-fix 보고 타이머 경합**: blocked 뒤 즉시 보고가 진행 중인 주기 보고와 겹치면 보고 사슬이 둘로 늘었다(옛 코드에서 5초 창에 PUT 6번 재현) → `reportNow` 가 진행 중 보고를 기다린 뒤 타이머를 지우고 새로 보고(사슬 하나), 결정적 회귀 테스트(엔진 준비를 주기 보고 읽기 중으로 맞춤; 옛 코드에서 실패 확인). 즉시 보고는 run 결과와 무관하게 매번(run 도중 잠김도 곧 보이게). (2) **must-fix 깨우기 정책**: 보안 잠금 폰을 30초마다 깨우던 것 → 한 번 시도 뒤에도 잠겨 있으면 보안 잠금으로 보고 화면을 끄고(KEYCODE_SLEEP) 풀린 것이 보이거나 빠졌다 다시 꽂힐 때까지 다시 깨우지 않음. 정책을 `unlock.ts`(createUnlocker)로 빼 단위 테스트 4개. (3) 스와이프 좌표를 UI 트리 루트 크기로(1080×2400 고정 제거, engineFor 도 같은 함수). (4) 두 길이 `lastDevices` 를 덮어쓰던 것 → 읽기 하나의 길(`inventory(opts)`) + 시작 순서 번호로 나중에 시작한 결과만 남김. (5) 읽기 실패 시 묵은 후보 대신 그 차례는 클레임 안 함. (6) 타깃마다 클레임 직전에 새로 읽기, 후보 계산·로그를 getter 에서 refresh 로, 빠진 기기 로그. (7) 운영자 문서: 데몬 `--help`, 설치본 README 에 깨우기 동작과 권장 설정. (8) 실기기 잠긴 폰 테스트: 증거 마스킹 보조 정규식, `--device` 기기로 조회, 2단계(사람이 풀면 같은 데몬이 제외 → 다시 후보 → Run verified)를 `SINCLAIR_TEST_UNLOCK_WAIT_MS` 로. 알려진 한계(run 도중 잠김은 run 뒤에 드러남)와 서버가 후보를 다시 거르지 않는 결정을 spec·fleet.md 에.
- **남은 것(ready-for-human):** 2단계 실기기 — 폰을 잠근 뒤 `! adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_TEST_UNLOCK_WAIT_MS=90000 npx vitest run apps/runner-agent/test/fleet-locked.device.test.ts` 를 실행하고 "잠금을 풀어 주세요" 가 나오면 90초 안에 푼다.
