# RPC 메서드와 기기 조회

러너가 서버 상태와 연결된 기기를 알아내고, 한 기기의 화면(스크린샷)과 UI 트리(`@ref` 포함)를 읽는 경로다.

## Sub-features

- `info-server` 서버 버전과 플랫폼 목록.
- `info-devices` 모든 백엔드의 기기를 합친 목록.
- `info-device` 특정 기기 정보.
- `read-screenshot` PNG 를 base64 로.
- `read-ui` `@ref` 가 붙은 UI 트리.

## How to get to it (user POV)

- 러너/스튜디오가 연결 직후 `server.info` → `devices.list` 를 호출한다.
- 기기를 고른 뒤 `device.info`, `device.screenshot`, `device.dump.ui` 를 호출한다.

## Driving it with rpc.sh

Preconditions:

- Baseline.

- **서버 정보.** `$S/rpc.sh $RUN server.info '{}' server-info`. `result.version` 이 `"0.0.0"`, `result.platforms` 가 `["android"]`.
- **기기 목록.** `$S/rpc.sh $RUN devices.list '{}' devices-list`. `result` 에 id `VERIFY1`, `VERIFY2` 가 이 순서로, 각 `state: "device"`.
- **기기 정보.** `$S/rpc.sh $RUN device.info '{"deviceId":"VERIFY2"}' device-info`. `result.id` 가 `VERIFY2`, `model` 이 `VerifyFake`.
- **스크린샷.** `$S/rpc.sh $RUN device.screenshot '{"deviceId":"VERIFY1"}' screenshot`. `result.format` 이 `png`, `result.base64` 가 `iVBORw0KGgo=` (PNG 시그니처 8바이트).
- **UI 트리.** `$S/rpc.sh $RUN device.dump.ui '{"deviceId":"VERIFY1"}' dump-ui`. `result.ref` 가 `@e0`, `children[0]` 이 `{ref:"@e1", role:"button", name:"로그인"}`, `children[1]` 이 `{ref:"@e2", role:"textbox", name:"아이디"}`.
- **증거.** `$RUN/evidence/{server-info,devices-list,device-info,screenshot,dump-ui}.json`. 조회 메서드는 `backend-calls.log` 에 줄을 남기지 않는 것이 정상이다.

## Gotchas

- 페이크의 스크린샷은 시그니처 8바이트뿐이다. 이미지 디코딩으로 증명하려 하지 않는다.
- `@ref` 는 그 dump 안에서만 유효하다. 새 dump 와 섞어 비교하지 않는다.
- 2026-11-07 기준 전 항목 검증 완료.
