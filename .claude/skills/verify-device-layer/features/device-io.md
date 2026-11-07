# 기기 입력

러너가 탭·롱프레스·스와이프·텍스트·키·하드웨어 버튼을 기기에 보내는 경로다. 서버는 파라미터를 검증하고 백엔드에 그대로 전달한다.

## Sub-features

- `io-tap` 좌표 탭.
- `io-longpress` 좌표 롱프레스, `durationMs` 기본 800.
- `io-swipe` `fromX/fromY` → `toX/toY` (camelCase), `durationMs` 기본 300.
- `io-text` 문자열 입력.
- `io-keys` 키 이름 배열.
- `io-button` `home|back|power|volume_up|volume_down`.
- `io-validate` 빠지거나 잘못된 파라미터는 `-32602`.

## How to get to it (user POV)

- 러너의 `agent.act` / locator 클릭이 `device.io.*` 로 변환되어 호출된다.
- 실기기 모드(`SINCLAIR_VERIFY_BACKEND=android`)에서 tap/longpress/swipe/text 는 **헬퍼가 ready 면 접근성 제스처·setText**(`POST /action`)로, 아니면 `adb shell input ...` 으로 간다(tap → `input tap x y`, longpress/swipe → `input swipe`, text → `input text '<공백은 %s>'`). keys/button 은 항상 `input keyevent`. 헬퍼가 거부하면(제스처 취소, 포커스된 입력 필드 없음) 같은 호출을 shell 로 한 번 재시도한다. 어느 경로를 탔는지는 `SINCLAIR_ADB_TRACE=1` 의 `input <id> <action> via helper|shell (<이유>)` 줄로 본다. 증거는 호출 전후 `device.screenshot` 두 장.

## Driving it with rpc.sh

Preconditions:

- Baseline. 순서 증명을 위해 이 파일의 호출은 한 RUN 안에서 연속으로 한다.

- **탭.** `$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":10,"y":20}' io-tap`. `result` 가 `null`, 로그에 `VERIFY1 tap 10,20`.
- **롱프레스 기본값.** `$S/rpc.sh $RUN device.io.longpress '{"deviceId":"VERIFY1","x":5,"y":6}' io-longpress`. 로그에 `VERIFY1 longpress 5,6 800`.
- **스와이프 기본값.** `$S/rpc.sh $RUN device.io.swipe '{"deviceId":"VERIFY1","fromX":0,"fromY":100,"toX":0,"toY":10}' io-swipe`. 로그에 `VERIFY1 swipe 0,100->0,10 300`.
- **텍스트.** `$S/rpc.sh $RUN device.io.text '{"deviceId":"VERIFY1","text":"hello"}' io-text`. 로그에 `VERIFY1 text hello`.
- **키.** `$S/rpc.sh $RUN device.io.keys '{"deviceId":"VERIFY1","keys":["KEYCODE_ENTER"]}' io-keys`. 로그에 `VERIFY1 keys KEYCODE_ENTER`.
- **버튼.** `$S/rpc.sh $RUN device.io.button '{"deviceId":"VERIFY1","button":"back"}' io-button`. 로그에 `VERIFY1 button back`.
- **검증 실패.** `$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":1}' io-tap-missing-y` 는 `error.code` `-32602`, 메시지 `y 가 필요합니다`. `$S/rpc.sh $RUN device.io.keys '{"deviceId":"VERIFY1","keys":"ENTER"}' io-keys-not-array` 는 `-32602`. 둘 다 로그에 줄이 추가되지 않는다.
- **증거.** `$RUN/evidence/io-*.json` 과 `backend-calls.log` 의 여섯 줄이 위 순서대로.

## Gotchas

- 실기기 `device.io.text`: 헬퍼 경로(setText)는 한글·이모지를 포커스된 입력 필드의 **끝에** 덧붙인다(IME 불필요). shell 경로는 커서 위치에 키 이벤트로 넣으므로 커서가 중간이면 두 경로의 결과가 다르다. 비밀번호 필드는 내용을 읽을 수 없어 헬퍼 경로가 통째로 바꾼다. 헬퍼가 없거나 포커스된 필드가 없으면 shell 경로인데 `input text` 는 ASCII 만 받아 비ASCII 는 `-32602` 로 거부된다(조용히 깨지지 않음).
- 진단: `createAndroidBackend({ preferShellInput: true })` 로 헬퍼가 있어도 shell 경로를 강제할 수 있다(두 경로 비교). 두 경로 모두 실패하면 오류 메시지에 "(헬퍼 경로 불가: …)" 가 덧붙는다. RPC 응답 자체에는 경로가 없고 `onInput`/트레이스로만 드러난다. 실기기 증거: `.scratch/android-backend/evidence/06-input-route-latest.json`.
- 실기기 `input` 은 종료 코드가 0 이 아니면 `-32603` 에 stderr 가 담긴다.
- `device.io.keys` 는 `KEYCODE_*` 또는 숫자 키코드만 받는다(그 외 `-32602`). `device.io.text` 의 리터럴 `%s` 는 `input text` 가 공백으로 바꾼다.

- 스와이프 파라미터 키는 `fromX/fromY/toX/toY` camelCase 로 확정(2026-11-07, 티켓 02). 소문자 `fromx` 를 보내면 `-32602 fromX 가 필요합니다`.

- `durationMs` 는 숫자여야 한다. 문자열 `"800"` 은 기본값으로 대체되는 것이 아니라 그대로 기본값 경로를 탄다 (`num()` 은 숫자가 아니면 dflt 반환). 명시값 증명은 숫자로 보낸다.
- `button` 은 `home|back|power|volume_up|volume_down` 만 받는다(`DEVICE_BUTTONS`, 그 외 `-32602`). 2026-11-07 확정.
- 빈 문자열 `text: ""` 는 `-32602` 다 (`str()` 이 빈 문자열을 거부). 빈 입력 시나리오는 지원되지 않는다.
- 2026-11-07 기준 페이크 모드 전 항목 검증 완료(스와이프 키 변경 후 재확인). 실기기 모드 레시피는 `android-backend.device.test.ts` 로만 검증.
