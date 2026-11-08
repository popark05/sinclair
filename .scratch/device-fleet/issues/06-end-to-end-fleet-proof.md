# 06: 종단 증명 — 데몬 2개, 기기 여러 대, 조건 타깃 매트릭스가 동시에 채워진다

**What to build:** `verify-runner-agent` 에 Fleet 전체를 한 번에 보이는 feature 를 더한다: 가짜 기기 여러 대(플랫폼·OS 가 다름, 하나는 잠김)를 가진 데몬 2개가 실제 bin 으로 떠서, 조건 타깃으로 정의된 Cycle 매트릭스를 동시에 채우고, 잠긴 기기는 건너뛰며, Cycle 이 verified 가 되고 셀마다 돈 기기가 보인다. 실기기 1회로 실제 기기가 fleet 에 보이고 lease 되어 Run 을 끝내는 것도 증명한다.

**Blocked by:** 03 (타깃 = 기기 선택 조건), 04 (워커 프로세스 + 다기기 데몬), 05 (기기 상태로 클레임 거르기)

**Status:** done

- [x] 스크립트: control-plane 기동 → 조건 타깃 3개짜리 Cycle → 가짜 기기를 나눠 가진 데몬 2개 → fleet 조회(idle/leased/untrusted) → Cycle verified, 셀별 기기, run 들의 실행 시간이 겹침
- [x] 잠긴 기기는 Run 을 받지 않고 사유가 fleet 에 보인다. 데몬 하나를 SIGKILL 하면 그 노드 기기가 offline 이 되고 그 Run 은 재시도 정책대로 다른 노드의 맞는 기기에서 대체된다
- [x] 증거 `.scratch/device-fleet/evidence/06-e2e-latest.json`(시리얼 마스킹, 경로 마스킹)
- [x] 실기기 1회: 꽂힌 기기가 fleet 에 idle 로 보이고, 그 기기 조건의 타깃 Run 이 lease 되어 끝나며, 잠그면 untrusted 로 바뀐다

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 방식: fake 엔진 데몬에 `--fake-devices <JSON>`(+ `SINCLAIR_AGENT_FAKE_DEVICES`, fake 전용, protocol `parseNodeReport` 로 검사)를 더하고, `verify-runner-agent/scripts/fleet-e2e.sh`(+ `.mjs`)로 두 단계 종단, 실기기는 실기기 노드 + 가짜 노드 한 Cycle, 잠금 → untrusted 는 05 증거 인용.
- 증명: `FLEET-E2E OK checks=11/11` 을 memory 두 번, SQLite 한 번(겹침 약 4초) — `.scratch/device-fleet/evidence/06-e2e-latest.json`(마지막은 SQLite). 1단계: a14→B-AND14, a13plus→A-AND13, ios→A-IOS17 가 겹쳐 돌아 verified, 도는 동안 leased 셋, 잠긴 B-AND13-LOCKED 는 untrusted(화면 잠김)·Run 없음, 두 데몬 exit 0. 2단계: B 가 a13plus 를 B-AND14 로 받은 뒤 SIGKILL → B 노드 offline → A 를 띄우자 대체 Run(retry:…)을 A-AND13 이 받아 verified, retriesUsed 1. 끝난 뒤 워커·데몬·서버 0.
- 실기기(SM-N981N …XLZW, Android 13, 화면 켜짐 상태 유지): 실기기 노드(mobile, 워커 모드)와 가짜 노드를 한 control-plane 에 붙여 조건 타깃 `real-model`(SM-N981N, OS 13~13)·`fake-model`(FakeEngine) Cycle → 각자 노드에서 끝나 verified, 실기기 Fleet 상태 idle → leased(그 Run) → idle, 두 데몬 exit 0 — `.scratch/device-fleet/evidence/06-device-latest.json`. 한 Cycle 의 suite 가 하나라 두 엔진에서 모두 도는 샘플(`fixtures/fleet-mixed`)을 썼다. 잠금 → untrusted 는 같은 기기로 05 에서 증명(`05-locked-device-latest.json`).
