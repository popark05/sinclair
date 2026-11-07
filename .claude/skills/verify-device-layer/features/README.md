# device-layer verification map

`packages/device-layer` JSON-RPC 서버의 사용자(러너·스튜디오) 관점 동작을 검증하는 유지 소스다. 기능 파일을 읽기 전에 이 인덱스를 먼저 읽는다.

## Baseline preconditions

- `S=.claude/skills/verify-device-layer/scripts`, `RUN=.e2e/verify-device-layer/<timestamp>-<purpose>` 로 리포 루트에서 시작한다.
- `$S/start.sh $RUN` 이 `READY` 를 출력했고 `$S/doctor.sh $RUN` 이 `DOCTOR OK` 다.
- 페이크 모드: 기기 `VERIFY1`, `VERIFY2` 가 `devices.list` 에 보인다. 실기기 모드(`SINCLAIR_VERIFY_BACKEND=android`, `adb kill-server` 선행): USB 로 꽂은 기기의 시리얼이 보인다.
- 이 실행이 띄우지 않은 서버는 절대 구동하지 않는다 (`server.json` 의 pid 가 우리 것).

## Driving conventions

- 모든 호출은 `$S/rpc.sh $RUN <method> '<params>' <evidence-name>` 으로 한다. 메서드 이름과 파라미터 키는 그대로 쓴다.
- 기기 id, `@ref`, 오류 코드는 문자 그대로 비교한다.
- 한 기능 파일은 Baseline 에서 시작한다. 선행 조건이 다르면 파일이 명시한다.
- `backend-calls.log` 는 서버 기동 시 비워지므로 순서 증명은 한 RUN 안에서 한다.

## Proof and skip reporting

- 증거는 `$RUN/evidence/<name>.json` (요청+응답) 과 `$RUN/backend-calls.log` 의 해당 줄을 함께 인용한다.
- 부수효과가 있는 호출(`device.io.*`, `device.apps.*`, `device.url`)은 응답만이 아니라 로그 줄의 내용과 **순서**를 증명한다.
- 오류 경로는 JSON-RPC `error.code` 와 HTTP 상태로 증명한다.
- 도달할 수 없는 경로는 시도한 명령과 미충족 선행 조건을 적어 실패로 보고한다. 다른 경로로 대신 검증했다고 쓰지 않는다.
- 페이크 백엔드 위의 증명임을 보고서에 항상 명시한다.

## Feature entry contract

각 기능 파일은 H1 제목과 한 문단 설명 뒤에 정확히 네 H2 를 이 순서로 가진다: `Sub-features`, `How to get to it (user POV)`, `Driving it with rpc.sh`, `Gotchas`.

## Features

- [RPC 메서드와 기기 조회](./rpc-methods.md): `server.info`, `devices.list`, `device.info`, `device.screenshot`, `device.dump.ui`.
- [기기 입력](./device-io.md): tap/longpress/swipe/text/keys/button 과 기본값, 파라미터 검증.
- [앱·URL 제어](./apps-and-url.md): `device.apps.launch/terminate`, `device.url`.
- [인증과 오류 응답](./auth-and-errors.md): 토큰, 404/401, 파싱 실패, 미지·미구현 메서드, 없는 기기.
- [기기별 직렬화](./serialization.md): 같은 기기의 동시 호출은 도착 순서대로 하나씩, 다른 기기는 서로 막지 않음.
