# Fleet 종단: 데몬 2개·기기 여러 대·조건 타깃 매트릭스가 동시에 채워진다

device-fleet 01~05 가 함께 도는지 실제 bin 으로 보인다. 가짜 기기를 나눠 가진 데몬 두 개가 조건 타깃 Cycle 을 워커 프로세스로 동시에 채우고, 잠긴 기기는 건너뛰며, 데몬 하나가 죽으면 그 노드 기기가 offline 이 되고 그 Run 은 다른 노드의 맞는 기기에서 대체된다.

## Sub-features

- `fleet-e2e-concurrent` 노드 A(Android 13·iOS 17)·B(Android 14·Android 13 잠김) → 타깃 `a14`·`a13plus`·`ios` 가 각각 B-AND14·A-AND13·A-IOS17 에서 겹쳐 돌아 verified, 셀마다 돈 기기, 도는 동안 Fleet leased 셋.
- `fleet-e2e-locked` 잠긴 B-AND13-LOCKED 는 untrusted(화면 잠김)이고 어떤 Run 도 받지 않는다.
- `fleet-e2e-node-death` B 만 띄워 `a13plus` Run 을 B-AND14 가 받은 뒤 SIGKILL → B 노드 offline → A 를 띄우면 대체 Run 을 A-AND13 이 받아 verified(retriesUsed 1).
- `fleet-e2e-device` 실기기 노드와 가짜 노드가 한 Cycle 의 두 조건 타깃 열(실기기 모델·OS / FakeEngine)을 각각 채워 verified, 실기기는 idle → leased → idle.

## How to get to it (user POV)

기기 노드마다 데몬 하나(`sinclair-agent daemon --control-plane …`)를 띄워 두면, QA 담당자는 Cycle 의 타깃을 기기 조건(플랫폼·모델·OS 범위)으로 정해 만들기만 한다. Fleet 에서 어떤 기기가 무엇을 돌리고 왜 쉬는지, Cycle 에서 셀마다 어느 기기가 돌았는지 본다.

## Driving it with scripts

```bash
$S/fleet-e2e.sh $RUN                 # 자체 control-plane(TTL 2초) → 두 단계 → 정리. 약 40초
# OK   동시: … (7줄) / OK   노드 사망: … (4줄)
# FLEET-E2E OK checks=11/11
# 증거: $RUN/evidence/fleet-e2e.json → 통과하면 .scratch/device-fleet/evidence/06-e2e-latest.json
SINCLAIR_INGEST_STORE=sqlite $S/fleet-e2e.sh $RUN   # SQLite 저장소로
# 실기기(잠금 해제·화면 켜짐 상태 유지): 실기기 노드 + 가짜 노드 한 Cycle
adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet-e2e.device.test.ts   # → 06-device-latest.json
```

## Gotchas

- 가짜 기기 목록은 `--fake-devices <JSON>`(fake 엔진 전용)으로 준다. 스크립트가 `$RUN/fake-devices-{a,b}.json` 을 만든다.
- 기기 배정을 결정적으로 만들려고 `a14` Run 을 먼저 등록한다(클레임은 등록 순서 FIFO — `a14` 에 맞는 기기는 B-AND14 하나뿐).
- 실기기 종단 테스트의 suite 는 두 엔진에서 모두 도는 샘플(`fixtures/fleet-mixed`: 실기기 "설정" / FakeEngine "Sinclair 로그인")이다. 한 Cycle 에는 suite 가 하나라서다.
- 잠금 → untrusted 의 실기기 증명은 05(`05-locked-device-latest.json`)를 인용한다. 실기기 종단은 기기가 한 대라 실기기끼리의 동시성은 보이지 않는다(가짜 기기 종단이 보인다).
