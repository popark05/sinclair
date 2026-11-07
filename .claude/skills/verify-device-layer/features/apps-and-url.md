# 앱·URL 제어

테스트 시작 시 앱을 실행하고, 끝나면 종료하고, 딥링크를 여는 경로다.

## Sub-features

- `app-launch` `appId` 로 실행.
- `app-terminate` `appId` 로 종료.
- `url-open` URL 열기.

## How to get to it (user POV)

- 러너의 테스트 fixture 가 attempt 시작 전 `device.apps.launch`, 종료 후 `device.apps.terminate` 를 부른다.
- 딥링크 시나리오가 `device.url` 을 부른다.

## Driving it with rpc.sh

Preconditions:

- Baseline.

- **실행.** `$S/rpc.sh $RUN device.apps.launch '{"deviceId":"VERIFY2","appId":"com.example.app"}' app-launch`. `result` `null`, 로그에 `VERIFY2 launch com.example.app`.
- **URL.** `$S/rpc.sh $RUN device.url '{"deviceId":"VERIFY2","url":"myapp://home"}' url-open`. 로그에 `VERIFY2 url myapp://home`.
- **종료.** `$S/rpc.sh $RUN device.apps.terminate '{"deviceId":"VERIFY2","appId":"com.example.app"}' app-terminate`. 로그에 `VERIFY2 terminate com.example.app`.
- **빠진 appId.** `$S/rpc.sh $RUN device.apps.launch '{"deviceId":"VERIFY2"}' app-launch-missing` 는 `-32602`, `appId 가 필요합니다`.
- **증거.** `$RUN/evidence/{app-launch,url-open,app-terminate,app-launch-missing}.json` 과 로그 세 줄.

## Gotchas

- `device.apps.install/uninstall/clear/foreground` 는 메서드 목록에는 있지만 미구현이라 `-32601` 이다. 구현되면 이 파일에 추가한다.
- 페이크는 앱 존재를 확인하지 않는다. 없는 appId 도 성공한다.
- 2026-11-07 기준 `app-launch-missing` 검증 완료. 나머지는 `device.url`/`terminate` 로그 형식이 `serve.ts` 와 같으므로 동일 경로.
