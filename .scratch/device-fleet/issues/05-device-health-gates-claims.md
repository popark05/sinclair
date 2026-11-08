# 05: 기기 상태로 클레임 거르기 — 잠긴·준비 안 된 기기는 Run 을 받지 않는다

**What to build:** 잠긴 기기, 헬퍼가 준비되지 않은 기기, 연결 승인을 안 한 기기는 클레임 후보에서 빠져 Run 이 blocked 로 끝나는 대신 다른 기기를 기다린다. 실행 중에 기기가 빠지거나 잠기면 그 기기는 offline/untrusted 가 되고 run 은 지금 규칙(blocked 또는 버려진 Run)으로 끝난다. QA 담당자는 fleet 에서 "왜 이 기기가 쉬고 있는지"(사유)를 본다.

**Blocked by:** 01 (Fleet 인벤토리), 02 (클레임 때 기기 lease)

**Status:** ready-for-agent

- [ ] 클레임 직전에 데몬이 후보 기기의 상태를 다시 확인(잠금·헬퍼). untrusted 기기는 내놓지 않고 보고에 사유를 남긴다
- [ ] 다시 idle 이 되면(잠금 해제·헬퍼 준비) 다음 보고·클레임부터 후보로 돌아온다. 헬퍼 온보딩은 클레임 전에 끝낸다(첫 run 이 온보딩 때문에 blocked 되지 않게)
- [ ] 실행 중 기기 상실: 엔진 오류(device-unavailable)로 run 이 blocked 로 끝나면 그 기기를 offline 으로 표시하고 lease 를 푼다
- [ ] 테스트: 잠긴 가짜 기기 + 정상 기기 → Run 은 정상 기기로, 잠긴 기기 해제 뒤 다음 Run 을 받음; 실행 중 기기 상실 → blocked + 기기 offline
- [ ] 실기기: 잠긴 상태에서 데몬이 Run 을 받지 않고 fleet 에 사유가 보이며, 잠금 해제 뒤 Run 을 받아 끝냄
