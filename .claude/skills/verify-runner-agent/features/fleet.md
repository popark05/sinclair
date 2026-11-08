# Fleet 인벤토리: 노드가 꽂힌 기기를 보고하고 control-plane 이 기기 상태를 안다

데몬(노드)이 시작할 때와 노드 TTL 의 1/3 마다 꽂힌 기기 목록을 `PUT /fleet/nodes/:agentId` 로 보고하고, `GET /fleet` 가 노드별 기기와 상태(idle / untrusted / offline)를 보여 준다. 상태는 저장하지 않고 조회 시점의 시계로 계산한다. 아직 클레임 조건은 아니다(device-fleet 02 부터).

## Sub-features

- `fleet-report` fake 데몬은 가짜 기기 하나(`fake-<agentId>`, 모델 `FakeEngine`)를, mobile 데몬은 소유한 디바이스 백엔드의 기기(모델·OS·연결·헬퍼·화면 잠금)를 보고한다.
- `fleet-states` 연결·승인·헬퍼 ready·잠금 없음 → `idle`; 미승인·adb offline·헬퍼 미준비·잠김 → `untrusted` + 사유; 노드 보고가 TTL 을 넘김 → `offline`("노드 보고 끊김"); 뽑혀서 보고에서 빠진 기기 → `offline`("보고에서 빠짐", 다시 꽂히면 돌아온다).
- `fleet-offline` 데몬이 죽으면 TTL 뒤 그 노드의 기기가 `offline`, 다른 노드는 그대로.
- `fleet-lease` 클레임 때 노드의 기기가 Run 에 lease 된다: 도는 동안 `leased`(+ `runId`), 끝나면(run.finished) 바로 `idle`. Cycle 뷰 run 행의 `lease.deviceId` 가 그 기기.
- `fleet-health-gate` 잠김·헬퍼 미준비·미승인 기기는 클레임 후보에서 빠진다(데몬 로그 "후보에서 뺌: <사유>" 한 번). Run 은 대기하고, 쓸 수 있게 되면 다음 클레임에 다시 후보로. 잠긴 mobile 기기는 30초에 한 번 깨우고 스와이프해 본다(비보안 잠금은 풀린다).
- `fleet-shared-backend` mobile 데몬은 백엔드를 하나 열어 두고 인벤토리와 run 이 같이 쓴다(run 이 USB 를 다시 잡지 않는다).

## How to get to it (user POV)

기기 노드에 데몬을 띄워 두면 QA 담당자는 `GET /fleet`(나중에 Console)에서 어느 노드에 어떤 기기가 있고 왜 쉬고 있는지(잠김, 헬퍼 미준비, 미승인) 본다.

## Driving it with scripts

```bash
$S/fleet.sh $RUN              # 자체 control-plane(TTL 2초) + fake 데몬 2개 → 느린 Run 하나로 leased 확인 → 하나 SIGKILL
# FLEET OK before=…:idle during=fleet-node-b:leased,… afterRun=…:idle afterKillA=fleet-node-b:idle,fleet-node-a:offline
# 증거: $RUN/evidence/fleet.json
curl -s http://127.0.0.1:<port>/fleet    # 떠 있는 서버에 직접(mobile 노드면 시리얼이 그대로 나온다: 증거로 남기기 전에 마스킹)
```

실기기: `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet.device.test.ts` → `.scratch/device-fleet/evidence/02-device-lease-device-latest.json`(잠금 해제 상태: idle → lease 받아 Run 완료 → idle). 티켓 01 증거는 `01-fleet-device-latest.json`(idle + Run), `01-fleet-device-locked.json`(잠김 → untrusted, run blocked).

## Gotchas

- 노드 TTL 은 Run lease TTL 과 같은 값이다(`--lease-ttl-ms`, 기본 60초). 짧게 줄이면 보고 간격도 줄어든다(하한 1초).
- 보고가 실패해도 데몬은 클레임을 계속한다. 로그는 처음 보고·실패·회복 때만 한 줄(시리얼을 쓰지 않는다).
- `GET /fleet` 응답에는 시리얼이 그대로 있다(control-plane 안의 식별자). 증거로 남길 때는 마스킹한다.
- mobile 데몬이 백엔드를 열지 못하면(헬퍼 APK 없음 등) 인벤토리가 비어 클레임하지 않고("후보 기기 없음" 한 번), 보고 때마다 다시 연다. 원인은 데몬 로그의 "디바이스 백엔드를 열지 못함".
- 노드는 지워지지 않는다: 한 번 보고한 agentId 는 데몬을 내려도 offline 으로 남는다(정리는 후속). 뽑힌 기기도 다시 꽂힐 때까지 "보고에서 빠짐" 으로 남는다.
- run 이 쓰는 중인 기기에는 인벤토리가 잠금 확인(dumpsys)을 보내지 않고 run 시작 때의 값(잠금 없음)을 쓴다.
- 기기 id 는 Fleet 전체에서 유일해야 한다(기기 lease 가 id 로 독점을 가른다). fake 기기는 노드마다 `fake-<agentId>`.
- 잠긴 기기 실기기 증명은 잠긴 폰에서만 돈다: `SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet-locked.device.test.ts` → `05-locked-device-latest.json`(Run 대기, untrusted/화면 잠김). 풀린 폰은 `fleet.device.test.ts`.
