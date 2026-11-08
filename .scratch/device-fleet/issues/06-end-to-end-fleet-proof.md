# 06: 종단 증명 — 데몬 2개, 기기 여러 대, 조건 타깃 매트릭스가 동시에 채워진다

**What to build:** `verify-runner-agent` 에 Fleet 전체를 한 번에 보이는 feature 를 더한다: 가짜 기기 여러 대(플랫폼·OS 가 다름, 하나는 잠김)를 가진 데몬 2개가 실제 bin 으로 떠서, 조건 타깃으로 정의된 Cycle 매트릭스를 동시에 채우고, 잠긴 기기는 건너뛰며, Cycle 이 verified 가 되고 셀마다 돈 기기가 보인다. 실기기 1회로 실제 기기가 fleet 에 보이고 lease 되어 Run 을 끝내는 것도 증명한다.

**Blocked by:** 03 (타깃 = 기기 선택 조건), 04 (워커 프로세스 + 다기기 데몬), 05 (기기 상태로 클레임 거르기)

**Status:** ready-for-agent

- [ ] 스크립트: control-plane 기동 → 조건 타깃 3개짜리 Cycle → 가짜 기기를 나눠 가진 데몬 2개 → fleet 조회(idle/leased/untrusted) → Cycle verified, 셀별 기기, run 들의 실행 시간이 겹침
- [ ] 잠긴 기기는 Run 을 받지 않고 사유가 fleet 에 보인다. 데몬 하나를 SIGKILL 하면 그 노드 기기가 offline 이 되고 그 Run 은 재시도 정책대로 다른 노드의 맞는 기기에서 대체된다
- [ ] 증거 `.scratch/device-fleet/evidence/06-e2e-latest.json`(시리얼 마스킹, 경로 마스킹)
- [ ] 실기기 1회: 꽂힌 기기가 fleet 에 idle 로 보이고, 그 기기 조건의 타깃 Run 이 lease 되어 끝나며, 잠그면 untrusted 로 바뀐다
