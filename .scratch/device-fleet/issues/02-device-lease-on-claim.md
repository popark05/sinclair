# 02: 클레임 때 기기 lease — Run 이 특정 기기에 묶여 돌고 끝나면 기기가 풀린다

**What to build:** 데몬이 Run 을 클레임할 때 자기 노드의 idle 기기를 함께 내놓고, control-plane 은 Run 과 함께 그 기기 하나를 lease(기기 상태 leased)해서 돌려준다. 데몬은 "꽂힌 첫 기기" 가 아니라 lease 받은 기기로 run 을 돌린다. 기기 lease 는 Run lease 와 수명이 묶여 run 종료·Run lease 만료·버려진 Run 정리·취소 때 풀린다. Cycle 뷰의 run 행과 fleet 에서 어느 기기가 어느 Run 을 돌리는지(마스킹 표시) 보인다.

**Blocked by:** 01 (Fleet 인벤토리)

**Status:** done

- [x] 클레임 요청에 후보 기기 목록, 응답에 lease 된 기기. 같은 기기는 동시에 두 Run 에 lease 되지 않는다(두 핸들 경쟁 포함, 저장소 계약 스위트)
- [x] 수명: heartbeat 가 기기 lease 도 연장, Run 종료 이벤트·lease 만료·대체(replaced)·취소 시 해제. 해제된 기기는 다음 클레임에 다시 나온다
- [x] 데몬: lease 받은 기기로 엔진을 만든다. 그 기기를 찾지 못하면 run 을 blocked 로 보고하고 기기를 풀어 준다
- [x] `run.started.deviceId` 가 lease 된 기기와 다르면 Cycle 뷰 warnings(기존 cycleId/targetId 불일치 규칙과 같은 방식)
- [x] 클레임 기기 없이 클레임하는 기존 에이전트(구버전)는 지금처럼 동작한다(하위 호환) — 동작과 경고를 명시
- [x] 테스트: 기기 2대 노드가 Run 2개를 서로 다른 기기로 받음, 기기 1대에 Run 2개면 하나는 대기, lease 만료·run 종료 뒤 기기 idle 복귀, 버려진 Run 정리 때 기기 해제

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 seam: (1) 저장소 — Run lease 에 `deviceId`, 기기가 바쁜 조건은 파생(만료 전·대체 안 됨·Run 미종료), 해제 엔드포인트 없음, SQLite 는 BEGIN IMMEDIATE 로 고르기+갱신, (2) HTTP — 클레임 `devices`, Fleet `leased`(+runId), deviceId 불일치 warnings, 구버전 `warning`, (3) 데몬 — 마지막 인벤토리를 후보로, lease 받은 기기로 엔진, (4) 증명.
- 결정: Run 종료는 control-plane 이 Run 이벤트(run.finished)로 안다 — 클레임·Fleet 조회 때 바쁜 기기의 Run 만 투영해 본다(노드당 몇 대라 싸다). "끝남" 은 되돌아가지 않아 오래된 집합이어도 안전. 기기 id 는 Fleet 전역 유일 전제(fake 는 `fake-<agentId>` 로 바꿈 — 01 에서 모든 노드가 `fake` 라 같은 기기로 보였다). 빈 후보가 없으면 Run 을 주지 않는다(`devices: []` 포함 — 기기 없는 노드는 클레임하지 않는다).
- 테스트: 저장소 계약(memory·SQLite) — 기기 2대 → Run 2개 다른 기기, 1대면 대기, 빈 목록 거부, Run 종료·만료·대체로 해제, heartbeat 가 deviceId 유지, 구버전 기기 없는 lease, **두 핸들 같은 기기 동시 클레임 → 하나만**. HTTP — 클레임·Fleet leased·run.finished 즉시 해제·구버전 경고·400·deviceId 불일치 warnings. 데몬 — 후보 전송, lease 기기로 엔진, run 중 leased/끝나면 idle, 로그 마스킹, 기기 없는 노드는 클레임 안 함. "버려진 Run 정리 때 기기 해제" 는 저장소의 대체 해제 + retry-e2e 재통과(10/10)로.
- 증명: `fleet.sh` → `FLEET OK`(느린 Run 동안 노드 b 기기 leased + runId, 끝나면 idle, Cycle 의 lease.deviceId 가 그 기기, warnings 없음; a SIGKILL → offline). `retry-e2e.sh` 재통과.
- 실기기: 재실행 때 기기가 다시 잠겨 있었다 — 잠긴 기기도 후보로 나가 lease 받고 run 이 blocked 로 끝남을 확인(05 가 고칠 동작). 잠금 해제 상태의 "lease 기기 = run.started 기기, 끝나면 idle" 은 재실행 대기(`fleet.device.test.ts`).
- 리뷰 반영(Standards + Spec). (1) **회귀**: mobile 데몬이 백엔드를 열지 못하면 인벤토리가 비어 영영 클레임하지 않았고 로그·문서는 "run 마다 다시 시도" 라 거짓이었다 → 보고 때마다 백엔드를 다시 열고, 후보가 없으면 "후보 기기 없음" 을 한 번 알린다(문서 정정). (2) 운영자의 `--device` 가 lease 받은 기기로 덮이던 것 → 고정 기기만 후보로. (3) 테스트 추가: --device 고정 + lease 받은 기기를 못 찾으면 blocked 로 끝나고 기기가 풀려 다음 Run 이 같은 기기로 받음. (4) SQLite busy timeout 2초(다른 프로세스의 BEGIN IMMEDIATE 에 바로 500 이 나지 않게), 기기 lease 조회는 기기를 가진 만료 전 lease 만 SQL 로 걸러 읽음(이력이 쌓여도 클레임·Fleet 조회 비용이 늘지 않게). (5) 두 핸들 테스트가 실제로 증명하는 것(await 뒤 다시 고르기·CAS; 프로세스 간 잠금은 아님)을 주석에 정직하게. (6) 낡은 문서: spec 의 "기기 lease 는 아직 없다", fleet.md 의 fake id, 용어집 Run lease 설명, 알려진 한계(lease 를 잃은 에이전트가 현재 테스트를 마치는 동안 기기가 다른 Run 에 lease 될 수 있는 짧은 창). (7) 실기기 증거는 `02-device-lease-device-latest.json` 로 따로(01 증거 보존).
- 2026-11-08 실기기 완료(SM-N981N …XLZW, 잠금 해제): 노드가 기기를 idle 로 보고 → 클레임이 그 기기를 lease(`lease.deviceId` = 그 기기) → run.started 기기가 lease 와 같음, warnings 없음 → Run verified(exit 0) → 기기 idle 복귀. 증거 `.scratch/device-fleet/evidence/02-device-lease-device-latest.json`. 증거 마스킹 보조 정규식이 run id(UUID) 조각을 시리얼로 오인하던 것을 대문자+숫자 토큰만 보게 고침.
