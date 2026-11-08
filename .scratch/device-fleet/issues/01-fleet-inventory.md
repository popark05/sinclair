# 01: Fleet 인벤토리 — 노드가 꽂힌 기기를 보고하고 control-plane 이 기기 상태를 안다

**What to build:** 데몬(노드)이 자기 식별자와 꽂힌 기기 목록(플랫폼·모델·OS 버전·헬퍼 상태·화면 잠금·연결 승인 여부)을 주기적으로 control-plane 에 보고한다. QA 담당자는 `GET /fleet` 에서 노드별 기기와 그 상태(idle / offline / untrusted)를 본다. 보고가 끊긴 노드의 기기는 일정 시간 뒤 offline 으로 보인다. 아직 lease 와 클레임은 바뀌지 않는다(기기는 보이기만 한다).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 노드 보고: 데몬이 시작할 때와 주기적으로(노드 보고 TTL 의 1/3, 기본 TTL 은 Run lease 와 같은 계열의 값, 이유 주석) 기기 목록을 보낸다. 보고는 노드 단위로 통째 교체(멱등)
- [ ] 기기 상태 규칙: 연결·승인·헬퍼 ready·잠금 해제 → idle; 미승인·헬퍼 미준비·잠김 → untrusted(사유 포함); 보고에서 사라졌거나 노드 보고가 TTL 을 넘김 → offline. leased 는 02 에서
- [ ] `GET /fleet`: 노드(agentId, 마지막 보고 시각)와 기기(id, 플랫폼, 모델, OS, 상태, 사유). 저장소는 memory·SQLite 둘 다(계약 스위트), 노드·기기 레코드는 마이그레이션 없이 들어가는지 확인
- [ ] FakeEngine 데몬은 가짜 기기 하나를 보고한다(테스트·verify 스킬용). mobile 데몬은 디바이스 레이어의 기기 목록 + 잠금 상태를 쓴다
- [ ] 개인정보: 시리얼은 control-plane 안에서는 식별자로 저장하되, 로그·증거·스킬 출력에서는 마스킹(`…XXXX`)
- [ ] 테스트: 노드 2개 보고 → fleet 조회, 보고 끊김 → offline(시계 주입), 잠긴 기기 → untrusted(사유); verify-ingest 또는 verify-runner-agent 에 fleet 조회 레시피
