# 02: 클레임 때 기기 lease — Run 이 특정 기기에 묶여 돌고 끝나면 기기가 풀린다

**What to build:** 데몬이 Run 을 클레임할 때 자기 노드의 idle 기기를 함께 내놓고, control-plane 은 Run 과 함께 그 기기 하나를 lease(기기 상태 leased)해서 돌려준다. 데몬은 "꽂힌 첫 기기" 가 아니라 lease 받은 기기로 run 을 돌린다. 기기 lease 는 Run lease 와 수명이 묶여 run 종료·Run lease 만료·버려진 Run 정리·취소 때 풀린다. Cycle 뷰의 run 행과 fleet 에서 어느 기기가 어느 Run 을 돌리는지(마스킹 표시) 보인다.

**Blocked by:** 01 (Fleet 인벤토리)

**Status:** ready-for-agent

- [ ] 클레임 요청에 후보 기기 목록, 응답에 lease 된 기기. 같은 기기는 동시에 두 Run 에 lease 되지 않는다(두 핸들 경쟁 포함, 저장소 계약 스위트)
- [ ] 수명: heartbeat 가 기기 lease 도 연장, Run 종료 이벤트·lease 만료·대체(replaced)·취소 시 해제. 해제된 기기는 다음 클레임에 다시 나온다
- [ ] 데몬: lease 받은 기기로 엔진을 만든다. 그 기기를 찾지 못하면 run 을 blocked 로 보고하고 기기를 풀어 준다
- [ ] `run.started.deviceId` 가 lease 된 기기와 다르면 Cycle 뷰 warnings(기존 cycleId/targetId 불일치 규칙과 같은 방식)
- [ ] 클레임 기기 없이 클레임하는 기존 에이전트(구버전)는 지금처럼 동작한다(하위 호환) — 동작과 경고를 명시
- [ ] 테스트: 기기 2대 노드가 Run 2개를 서로 다른 기기로 받음, 기기 1대에 Run 2개면 하나는 대기, lease 만료·run 종료 뒤 기기 idle 복귀, 버려진 Run 정리 때 기기 해제
