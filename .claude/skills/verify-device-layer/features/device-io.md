# 기기 입력

러너가 탭·롱프레스·스와이프·텍스트·키·하드웨어 버튼을 기기에 보내는 경로다. 서버는 파라미터를 검증하고 백엔드에 그대로 전달한다.

## Sub-features

- `io-tap` 좌표 탭.
- `io-longpress` 좌표 롱프레스, `durationMs` 기본 800.
- `io-swipe` `fromx/fromy` → `tox/toy` (소문자), `durationMs` 기본 300.
- `io-text` 문자열 입력.
- `io-keys` 키 이름 배열.
- `io-button` `home|back|power|volume_up|volume_down`.
- `io-validate` 빠지거나 잘못된 파라미터는 `-32602`.

## How to get to it (user POV)

- 러너의 `agent.act` / locator 클릭이 `device.io.*` 로 변환되어 호출된다.

## Driving it with rpc.sh

Preconditions:

- Baseline. 순서 증명을 위해 이 파일의 호출은 한 RUN 안에서 연속으로 한다.

- **탭.** `$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":10,"y":20}' io-tap`. `result` 가 `null`, 로그에 `VERIFY1 tap 10,20`.
- **롱프레스 기본값.** `$S/rpc.sh $RUN device.io.longpress '{"deviceId":"VERIFY1","x":5,"y":6}' io-longpress`. 로그에 `VERIFY1 longpress 5,6 800`.
- **스와이프 기본값.** `$S/rpc.sh $RUN device.io.swipe '{"deviceId":"VERIFY1","fromx":0,"fromy":100,"tox":0,"toy":10}' io-swipe`. 로그에 `VERIFY1 swipe 0,100->0,10 300`.
- **텍스트.** `$S/rpc.sh $RUN device.io.text '{"deviceId":"VERIFY1","text":"hello"}' io-text`. 로그에 `VERIFY1 text hello`.
- **키.** `$S/rpc.sh $RUN device.io.keys '{"deviceId":"VERIFY1","keys":["KEYCODE_ENTER"]}' io-keys`. 로그에 `VERIFY1 keys KEYCODE_ENTER`.
- **버튼.** `$S/rpc.sh $RUN device.io.button '{"deviceId":"VERIFY1","button":"back"}' io-button`. 로그에 `VERIFY1 button back`.
- **검증 실패.** `$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":1}' io-tap-missing-y` 는 `error.code` `-32602`, 메시지 `y 가 필요합니다`. `$S/rpc.sh $RUN device.io.keys '{"deviceId":"VERIFY1","keys":"ENTER"}' io-keys-not-array` 는 `-32602`. 둘 다 로그에 줄이 추가되지 않는다.
- **증거.** `$RUN/evidence/io-*.json` 과 `backend-calls.log` 의 여섯 줄이 위 순서대로.

## Gotchas

- 스와이프 파라미터 키는 `fromx/fromy/tox/toy` **소문자**다 (`server.ts` 의 `point(p, 'from')` 이 `${prefix}x` 로 조합). `fromX` 를 보내면 `-32602 fromx 가 필요합니다`. 스펙에는 이 키 이름이 없다. 2026-11-07 확인.

- `durationMs` 는 숫자여야 한다. 문자열 `"800"` 은 기본값으로 대체되는 것이 아니라 그대로 기본값 경로를 탄다 (`num()` 은 숫자가 아니면 dflt 반환). 명시값 증명은 숫자로 보낸다.
- `button` 값은 서버가 검증하지 않고 백엔드에 넘긴다. 잘못된 이름도 페이크에서는 성공한다. 실제 백엔드가 붙으면 이 Gotcha 를 갱신한다.
- 빈 문자열 `text: ""` 는 `-32602` 다 (`str()` 이 빈 문자열을 거부). 빈 입력 시나리오는 지원되지 않는다.
- 2026-11-07 기준 전 항목 검증 완료.
