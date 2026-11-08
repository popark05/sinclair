# 01: Fleet 인벤토리 — 노드가 꽂힌 기기를 보고하고 control-plane 이 기기 상태를 안다

**What to build:** 데몬(노드)이 자기 식별자와 꽂힌 기기 목록(플랫폼·모델·OS 버전·헬퍼 상태·화면 잠금·연결 승인 여부)을 주기적으로 control-plane 에 보고한다. QA 담당자는 `GET /fleet` 에서 노드별 기기와 그 상태(idle / offline / untrusted)를 본다. 보고가 끊긴 노드의 기기는 일정 시간 뒤 offline 으로 보인다. 아직 lease 와 클레임은 바뀌지 않는다(기기는 보이기만 한다).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 노드 보고: 데몬이 시작할 때와 주기적으로(노드 보고 TTL 의 1/3, 기본 TTL 은 Run lease 와 같은 계열의 값, 이유 주석) 기기 목록을 보낸다. 보고는 노드 단위로 통째 교체(멱등)
- [ ] 기기 상태 규칙: 연결·승인·헬퍼 ready·잠금 해제 → idle; 미승인·헬퍼 미준비·잠김 → untrusted(사유 포함); 보고에서 사라졌거나 노드 보고가 TTL 을 넘김 → offline. leased 는 02 에서
- [ ] `GET /fleet`: 노드(agentId, 마지막 보고 시각)와 기기(id, 플랫폼, 모델, OS, 상태, 사유). 저장소는 memory·SQLite 둘 다(계약 스위트). SQLite 는 새 테이블이라 스키마 마이그레이션 3 이 필요하다(기존 DB 는 열 때 올라간다)
- [ ] FakeEngine 데몬은 가짜 기기 하나를 보고한다(테스트·verify 스킬용). mobile 데몬은 디바이스 레이어의 기기 목록 + 잠금 상태를 쓴다
- [ ] 개인정보: 시리얼은 control-plane 안에서는 식별자로 저장하되, 로그·증거·스킬 출력에서는 마스킹(`…XXXX`)
- [ ] 테스트: 노드 2개 보고 → fleet 조회, 보고 끊김 → offline(시계 주입), 잠긴 기기 → untrusted(사유); verify-ingest 또는 verify-runner-agent 에 fleet 조회 레시피

## Comments

- 2026-11-08 구현(Opus 5.5). 승인된 seam: (1) 상태 규칙 순수 함수 `deviceStatus` + `FleetStore`(memory·SQLite 계약 스위트, SQLite 스키마 3 `fleet_nodes`), (2) HTTP `PUT /fleet/nodes/:agentId`·`GET /fleet`(노드 TTL = Run lease TTL, 응답 `{ttlMs}`), (3) 데몬 보고(시작 + TTL/3, 실패해도 클레임 계속) — mobile 데몬은 디바이스 백엔드 하나를 소유(prefactor: `openAndroidNode` 가 백엔드를 잡고 `engineFor` 가 그 위에 run 용 엔진, `createEngine` 은 run 하나 동안만 여는 래퍼), (4) `fleet.sh` + 실기기 테스트.
- 계약: 보고 본문은 apps 사이 계약이라 protocol 에 `NodeReport`/`parseNodeReport`(닫힌 검증기, 상수 드리프트 테스트)를 먼저 두었다.
- 증명: `fleet.sh` → `FLEET OK`(fake 데몬 2개 idle, 하나 SIGKILL 뒤 offline, 다른 노드 idle). 실기기(SM-N981N …XLZW): 기기가 잠긴 상태로 돌아 `untrusted`/"화면 잠김" 보고와 run blocked 를 확인(`.scratch/device-fleet/evidence/01-fleet-device-locked.json`). 잠금 해제 상태의 idle + 같은 백엔드로 Run 완료는 재실행 대기.
