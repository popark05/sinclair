# Fleet 인벤토리: 노드가 꽂힌 기기를 보고하고 control-plane 이 기기 상태를 안다

데몬(노드)이 시작할 때와 노드 TTL 의 1/3 마다 꽂힌 기기 목록을 `PUT /fleet/nodes/:agentId` 로 보고하고, `GET /fleet` 가 노드별 기기와 상태(idle / untrusted / offline)를 보여 준다. 상태는 저장하지 않고 조회 시점의 시계로 계산한다. 아직 클레임 조건은 아니다(device-fleet 02 부터).

## Sub-features

- `fleet-report` fake 데몬은 가짜 기기 하나(`fake`, 모델 `FakeEngine`)를, mobile 데몬은 소유한 디바이스 백엔드의 기기(모델·OS·연결·헬퍼·화면 잠금)를 보고한다.
- `fleet-states` 연결·승인·헬퍼 ready·잠금 없음 → `idle`; 미승인·adb offline·헬퍼 미준비·잠김 → `untrusted` + 사유; 노드 보고가 TTL 을 넘김 → `offline`(사유 "노드 보고 끊김").
- `fleet-offline` 데몬이 죽으면 TTL 뒤 그 노드의 기기가 `offline`, 다른 노드는 그대로.
- `fleet-shared-backend` mobile 데몬은 백엔드를 하나 열어 두고 인벤토리와 run 이 같이 쓴다(run 이 USB 를 다시 잡지 않는다).

## How to get to it (user POV)

기기 노드에 데몬을 띄워 두면 QA 담당자는 `GET /fleet`(나중에 Console)에서 어느 노드에 어떤 기기가 있고 왜 쉬고 있는지(잠김, 헬퍼 미준비, 미승인) 본다.

## Driving it with scripts

```bash
$S/fleet.sh $RUN              # 자체 control-plane(TTL 2초) + fake 데몬 2개 → 하나 SIGKILL
# FLEET OK before=fleet-node-b:idle,fleet-node-a:idle after=fleet-node-b:idle,fleet-node-a:offline
# 증거: $RUN/evidence/fleet.json
curl -s http://127.0.0.1:<port>/fleet    # 떠 있는 서버에 직접
```

실기기: `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet.device.test.ts` → `.scratch/device-fleet/evidence/01-fleet-device-latest.json`(잠금 해제 상태: idle + Run 완료). 잠긴 기기는 `untrusted`/"화면 잠김" 으로 보이고 run 은 blocked(`01-fleet-device-locked.json`).

## Gotchas

- 노드 TTL 은 Run lease TTL 과 같은 값이다(`--lease-ttl-ms`, 기본 60초). 짧게 줄이면 보고 간격도 줄어든다(하한 1초).
- 보고가 실패해도 데몬은 클레임을 계속한다. 로그는 처음 보고·실패·회복 때만 한 줄(시리얼을 쓰지 않는다).
- `GET /fleet` 응답에는 시리얼이 그대로 있다(control-plane 안의 식별자). 증거로 남길 때는 마스킹한다.
- mobile 데몬이 백엔드를 열지 못하면(헬퍼 APK 없음 등) 인벤토리는 비고 run 마다 여는 기존 경로로 돈다.
