# 기기별 직렬화

같은 기기를 향한 호출은 도착 순서대로 하나씩 실행되고, 다른 기기의 호출은 서로를 막지 않는다. 온디바이스 에이전트는 동시 요청을 안전하게 처리하지 못하기 때문이다.

## Sub-features

- `ser-order` 같은 기기 동시 호출의 백엔드 실행 순서 = 도착 순서.
- `ser-isolate` 다른 기기는 병렬.
- `ser-fail` 한 호출이 실패해도 같은 기기의 다음 호출은 정상.

## How to get to it (user POV)

- 러너가 한 기기에 act 를 연달아 보내거나, 여러 기기를 동시에 돌릴 때.

## Driving it with rpc.sh

Preconditions:

- Baseline. 페이크 백엔드는 지연이 없고 `rpc.sh` 의 요청 id 는 밀리초 시각이라, HTTP 로는 동시 도착을 만들 수도 도착 순서를 기록할 수도 없다. **`ser-order` 와 `ser-isolate` 는 HTTP 로 증명하지 않는다.** 모든 인터리빙에 대한 증명은 `verify-rpc-serialization` 스킬(`packages/device-layer/test/rpc-serialization.exhaustive.test.ts`)이 맡는다. 여기서는 `ser-fail` 만 사용자 경로로 증명한다.

- **실패 후 정상.** `$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":1}' ser-fail` 이 `-32602` 인 뒤 `$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":2,"y":2}' ser-after-fail` 이 `result: null` 이고 로그에 `VERIFY1 tap 2,2`.
- **증거.** `$RUN/evidence/ser-fail.json`, `ser-after-fail.json`, `backend-calls.log`.

## Gotchas

- 셸에서 `&` 로 동시에 보낸 curl 은 도착 순서가 뒤섞이고 요청 id 도 겹친다(2026-11-07 관찰: t3,t1,t2). 그 결과로 직렬화 위반을 판정하지 않는다.
- 파라미터 검증 실패(`-32602`)는 핸들러 안에서 던지므로 직렬화 체인을 거친다. 체인이 실패를 삼키지 못하면 다음 호출이 모두 실패한다. 그것이 `ser-fail` 이 지키는 회귀다.
