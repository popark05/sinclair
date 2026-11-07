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
- **기기 목록.** `$S/rpc.sh $RUN devices.list '{}' devices-list`. 페이크: `result` 에 id `VERIFY1`, `VERIFY2` 가 이 순서로, 각 `state: "device"`. 실기기: 꽂은 기기의 시리얼, `model`(`getprop ro.product.model`), `osVersion`(`ro.build.version.release`), `state` 가 `device` / `unauthorized` / `offline`. 후자 둘은 `stateDetail` 에 원인이 있다.
- **기기 상태 전이(실기기).** 기기에서 "USB 디버깅 허용" 팝업을 거부하면 `unauthorized` + `stateDetail` 에 "USB 디버깅 허용"; `adb start-server` 로 인터페이스를 점유시키면 `offline` + `stateDetail` 에 "adb kill-server". 목록은 2초 캐시이므로 상태 변화는 2초 뒤 호출에 반영된다.
- **기기 정보.** `$S/rpc.sh $RUN device.info '{"deviceId":"VERIFY2"}' device-info`. `result.id` 가 `VERIFY2`, `model` 이 `VerifyFake`.
- **스크린샷.** `$S/rpc.sh $RUN device.screenshot '{"deviceId":"VERIFY1"}' screenshot`. `result.format` 이 `png`, `result.base64` 가 `iVBORw0KGgo=` (PNG 시그니처 8바이트).
- **UI 트리.** `$S/rpc.sh $RUN device.dump.ui '{"deviceId":"VERIFY1"}' dump-ui`. 페이크: `result.ref` 가 `@e0`, `children[0]` 이 `{ref:"@e1", role:"button", name:"로그인"}`, `children[1]` 이 `{ref:"@e2", role:"textbox", name:"아이디"}`. 실기기: 접근성 헬퍼의 `/dump` 가 그대로 온다. 홈 화면이면 런처 아이콘들이 `role: button`, `name: <앱 이름>`, `testId: ...launcher:id/home_icon` 으로 보인다.
- **헬퍼 상태(실기기).** `device.info` 의 `helper` 가 `{state:"ready", version:"0.1.0"}` 이어야 `device.dump.ui` 가 된다. 연결 직후 온보딩(설치 → `settings put --user 0` → 포워드 → 토큰 → `/ping`)이 자동으로 돌며 보통 1~3초. 그 전에는 `helper` 가 없다. ready 가 아니면 `device.dump.ui` 는 `-32002` 와 `helper.detail` 의 원인을 돌려준다.
- **증거.** `$RUN/evidence/{server-info,devices-list,device-info,screenshot,dump-ui}.json`. 조회 메서드는 `backend-calls.log` 에 줄을 남기지 않는 것이 정상이다.

## Gotchas

- 실기기 헬퍼 상태: `not-installed`(APK 없음·설치 실패, 리포에서 `android-helper` 를 빌드), `disabled`(접근성 설정이 적용되지 않음. Secure Folder 기기에서 `--user 0` 누락 상황이며 백엔드는 항상 `--user 0` 을 쓴다), `unreachable`(서버는 떠 있는데 401. 토큰 재전송 뒤에도 그러면 헬퍼 버전 불일치 의심). 사용자가 설정에서 서비스를 끄면 다음 `device.dump.ui` 가 자동으로 다시 켠다(2026-11-07 실기기 확인).

- 실기기 모드에서 `devices.list` 가 `[]` 이면 adb server 가 떠 있거나(`nc -z 127.0.0.1 5037`) 케이블/USB 디버깅 문제다. 첫 연결은 최대 1.5초 판정을 기다리고, 승인 대기는 기다리지 않는다.
- `devices.list` 결과는 2초 캐시다. 같은 RUN 안에서 상태 변화를 보려면 2초 뒤에 다시 호출한다.

- 페이크의 스크린샷은 시그니처 8바이트뿐이다. 이미지 디코딩으로 증명하려 하지 않는다.
- `@ref` 는 그 dump 안에서만 유효하다. 새 dump 와 섞어 비교하지 않는다.
- 2026-11-07 기준 페이크 모드 전 항목 검증 완료. 실기기 모드의 목록·상태 전이 레시피는 아직 미검증.
