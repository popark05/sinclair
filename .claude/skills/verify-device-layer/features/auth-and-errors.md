# 인증과 오류 응답

서버는 127.0.0.1 에만 바인딩하고 Bearer 토큰을 요구한다. 잘못된 요청은 JSON-RPC 오류 코드로 답한다.

## Sub-features

- `auth-missing` 토큰 없음 → HTTP 401.
- `auth-wrong-path` `/rpc` 외 경로 또는 GET → 404.
- `err-parse` JSON 아님 → `-32700`.
- `err-invalid` `jsonrpc` 가 `"2.0"` 이 아니거나 `method` 없음 → `-32600`.
- `err-unknown` 목록에 없는 메서드 → `-32601`.
- `err-unimplemented` 목록에는 있으나 미구현 → `-32601`.
- `err-no-device` 없는 기기 → `-32000`.

## How to get to it (user POV)

- 토큰이 잘못 설정된 러너, 오래된 클라이언트, 끊긴 기기를 가리키는 호출.

## Driving it with rpc.sh

Preconditions:

- Baseline. `PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN/server.json','utf8')).port")`.

- **토큰 없음.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:$PORT/rpc --data '{}'` → `401`. (doctor 도 이것을 확인한다.)
- **잘못된 경로.** `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/` → `404`.
- **파싱 실패.** `TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('$RUN/server.json','utf8')).token"); curl -s -X POST http://127.0.0.1:$PORT/rpc -H "authorization: Bearer $TOKEN" --data 'not json' | tee $RUN/evidence/err-parse.json` → `error.code` `-32700`.
- **잘못된 요청.** 같은 curl 로 `--data '{"id":1,"method":"server.info"}'` → `-32600`.
- **미지 메서드.** `$S/rpc.sh $RUN device.hack '{}' err-unknown` → `-32601`.
- **미구현 메서드.** `$S/rpc.sh $RUN device.screenrecord '{"deviceId":"VERIFY1"}' err-unimplemented` → `-32601`.
- **없는 기기.** `$S/rpc.sh $RUN device.io.tap '{"deviceId":"NOPE","x":1,"y":2}' err-no-device` → `-32000`, 메시지 `기기를 찾을 수 없음: NOPE`.
- **증거.** `$RUN/evidence/err-*.json` 과 curl 의 상태 코드 출력.

## Gotchas

- 오류 응답도 HTTP 200 이다. HTTP 상태가 아니라 `error.code` 를 본다. 401/404 만 HTTP 레벨이다.
- 파싱 실패 응답의 `id` 는 `0` 이다.
- 2026-11-07 기준 전 항목 검증 완료.
