---
name: verify-device-layer
description: "Sinclair 디바이스 레이어(packages/device-layer)의 JSON-RPC HTTP 서버를 실제로 띄워 사용자(러너/스튜디오) 경로로 구동하고 증거를 남긴다. 디바이스 RPC 메서드, 파라미터 검증, 기기별 직렬화, 인증을 바꿨을 때, 또는 '변경이 실제로 동작하는지 증명해 달라'는 요청에 쓴다."
---

# verify-device-layer

Sinclair에서 오늘 실제로 구동되는 표면은 `packages/device-layer`의 JSON-RPC 서버 하나다 (`apps/*`는 아직 빈 골격). 이 스킬은 그 서버를 **페이크 백엔드**로 띄워 러너가 하듯 HTTP로 호출하고, 응답과 백엔드 부수효과를 파일로 남긴다. 실제 Android/iOS 백엔드가 생기면 `scripts/serve.ts`에 그 백엔드를 추가하고 `features/`를 갱신한다 (`/pstack:maintain-verification-skill`).

모든 명령은 리포 루트에서 실행한다. `RUN`은 이 실행만의 디렉터리이며, 포트는 매번 OS가 배정(`port: 0`)하므로 여러 인스턴스가 동시에 떠도 충돌하지 않는다.

```bash
S=.claude/skills/verify-device-layer/scripts
RUN=.e2e/verify-device-layer/$(date +%Y%m%d-%H%M%S)-<목적>
```

## Launch

```bash
$S/start.sh $RUN
# 출력 마지막 줄: READY port=<n> runDir=<RUN>
```

- `scripts/serve.ts`가 `createDeviceServer([backend])` + `serveHttp()`를 띄운다. 기본 백엔드는 페이크(기기 `VERIFY1`, `VERIFY2`, android, state=device).
- **실기기 모드:** `SINCLAIR_VERIFY_BACKEND=android $S/start.sh $RUN` 이면 `createAndroidBackend()`(직접 USB)를 쓴다. 먼저 `adb kill-server`(adb server 가 USB 인터페이스를 점유한다). READY 줄의 `backend=android` 로 모드를 확인한다. 실기기 모드에서는 `backend-calls.log` 가 비어 있다(페이크만 기록한다).
- 준비 완료 기준은 `server.out`의 `READY` 줄이다. 그때 `$RUN/server.json`(port, token, pid)이 존재한다.
- `node --experimental-transform-types`로 실행한다. 제품 코드(`rpc.ts`의 `RpcError`)가 생성자 파라미터 프로퍼티를 쓰므로 strip-only 모드로는 로드되지 않는다.
- 시드 데이터·마이그레이션 없음. 빈 `RUN` 디렉터리에서 바로 사용 가능 상태가 된다.
- 이상하면 `cat $RUN/server.out`.

## Doctor

```bash
$S/doctor.sh $RUN
```

읽기 전용. pid 생존, 포트 소유자가 그 pid인지(`lsof`), 토큰 없는 요청이 401인지, `server.info`가 `version 0.0.0`을 돌려주는지 확인하고 `DOCTOR OK` 또는 `DOCTOR FAIL: <이유>`를 출력한다. 뭔가 이상하면 드라이브 전에 먼저 돌린다.

## Drive

```bash
$S/rpc.sh $RUN <method> '<params-json>' [evidence-name]
```

- `POST http://127.0.0.1:<port>/rpc`, `authorization: Bearer <token>` 헤더, JSON-RPC 2.0 본문. 응답을 stdout에 출력한다.
- `evidence-name`을 주면 요청+응답을 `$RUN/evidence/<name>.json`에 저장한다. 증거가 필요한 호출은 항상 이름을 준다.
- 안정적인 핸들: 메서드 이름은 `packages/protocol/src/device-rpc.ts`의 `DEVICE_RPC_METHODS`, 기기 id는 `VERIFY1`/`VERIFY2`, UI 요소는 `device.dump.ui` 결과의 `@ref`(`@e1` 로그인 버튼, `@e2` 아이디 입력).
- 레시피는 `features/`에 있다. 먼저 `features/README.md`를 읽는다.

예:

```bash
$S/rpc.sh $RUN device.dump.ui '{"deviceId":"VERIFY1"}' dump-ui
$S/rpc.sh $RUN device.io.tap '{"deviceId":"VERIFY1","x":10,"y":20}' tap
```

## Evidence

위치: `$RUN/evidence/*.json`(요청+응답), `$RUN/backend-calls.log`(백엔드가 실제로 받은 호출, `<ISO시각> <deviceId> <동작>` 한 줄씩), `$RUN/server.out`.

증명 기준:

- 러너가 쓰는 실제 경로(HTTP + 토큰 + JSON-RPC)로 호출한다. `RpcDispatcher.handle()`을 직접 부르는 것은 단위 테스트지 증명이 아니다.
- 동작과 결과 상태를 함께 남긴다. `device.io.*`의 `result: null`만으로는 부족하고 `backend-calls.log`에 해당 줄이 **그 순서로** 찍혀야 한다.
- 오류 경로는 오류 코드로 증명한다: `-32000` 기기 없음, `-32602` 파라미터 누락, `-32601` 미구현/미지 메서드, HTTP 401 토큰 없음.
- 페이크 백엔드는 프로덕션 경계(`DeviceBackend` 인터페이스) 바로 아래를 대체한다. 서버 계약은 증명되지만 **실제 기기 동작은 증명되지 않는다.** 실기기 증명은 `SINCLAIR_VERIFY_BACKEND=android` 로 다시 돌린다. 보고서에 어느 모드였는지 쓴다.

## Cleanup

```bash
$S/stop.sh $RUN
```

`$RUN/server.pid`의 pid에만 SIGTERM(3초 후 SIGKILL)을 보낸다. 프로세스 이름으로 죽이지 않는다. `server.pid`/`server.json`만 지우고 `evidence/`, `backend-calls.log`, `server.out`은 남긴다. 실패한 시도 뒤에도 반드시 돌린다. `.e2e/`는 git-ignore 되어 있다.

## Helpers

| 스크립트 | 역할 |
| --- | --- |
| `scripts/start.sh <RUN>` | 서버 기동, READY 대기, pid 기록 |
| `scripts/doctor.sh <RUN>` | 읽기 전용 상태 점검 |
| `scripts/rpc.sh <RUN> <method> [params] [name]` | JSON-RPC 호출 + 증거 저장 |
| `scripts/stop.sh <RUN>` | 우리가 띄운 서버만 종료 |
| `scripts/serve.ts <RUN>` | 서버 본체 (start.sh 가 호출). 검증 스캐폴딩이며 제품 코드가 아니다 |

## 검증 이력

- 2026-11-07: 실기기 모드 추가(`SINCLAIR_VERIFY_BACKEND=android`). 기기 없이 기동·doctor·`devices.list`(빈 목록)까지 확인. 같은 날 실기기 USB 로 `android-backend.device.test.ts` 통과(`devices.list` 에 device 상태·모델·OS). 실기기 모드의 HTTP 레시피 완주는 아직.
- 2026-11-07: 커밋 `0afc66c` 기준으로 Launch → Doctor → `rpc-methods` 기능 드라이브 → 증거 확인 → Cleanup 을 1회 완주. 정지 후 doctor 가 FAIL 로 바뀌는 것도 확인.
