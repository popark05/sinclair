---
name: verify-rpc-serialization
description: "디바이스 레이어 RpcDispatcher 의 기기별 호출 직렬화(같은 기기는 도착 순서대로 하나씩, 다른 기기는 서로 안 막음, 실패해도 체인 유지, 잠금 누수 없음)를 제한 범위 안의 모든 인터리빙에 대해 실제 코드로 검사한다. packages/device-layer/src/rpc.ts 의 handle/serialized 나 그 호출 경로를 바꿀 때, 또는 '이 경쟁 상태를 증명해 달라'는 요청에 쓴다."
---

# verify-rpc-serialization

## 속성과 해악 (한 문장씩)

- **속성:** 같은 `deviceId` 를 가진 JSON-RPC 호출은 도착 순서대로 한 번에 하나만 백엔드로 가고, 다른 기기나 기기 없는 호출은 그것에 막히지 않으며, 핸들러가 실패해도 다음 호출은 정상 실행되고, 모든 호출이 끝나면 잠금 맵이 비어 있다.
- **해악:** 깨지면 온디바이스 에이전트가 동시 요청을 받아 입력이 섞이거나(잘못된 탭·텍스트), 한 번의 실패 뒤 그 기기의 모든 호출이 실패하거나, 한 기기가 다른 기기의 테스트를 멈춘다. `REVIEW.md` 가 merge 차단급 "중요" 항목으로 지정한 경쟁 상태다.

## 도구와 이유

TypeScript 에는 코드 자체를 돌리는 검증기가 없다. 핸들러 완료 시점만이 이 코드의 유일한 비결정성이므로, **실제 `RpcDispatcher` 를 경로마다 새로 만들어 모든 도착·완료 인터리빙과 성공·실패 조합을 전수 실행**한다 (제한 범위 bounded exhaustive check). 모델이 아니라 코드를 검사하므로 "모델과 코드가 다른" 오류가 없고, vitest 하나면 돌아간다. TLA+ 모델은 프로미스 체인을 다시 모델링해야 해 코드와 어긋날 위험이 더 크고, 설치도 필요해 택하지 않았다.

## 실행

```bash
npx vitest run packages/device-layer/test/rpc-serialization.exhaustive.test.ts
```

`pnpm test` 에도 포함된다. 약 3초. 통과 시 `직렬화 전수 검사: 시나리오 39, 완료 경로 2706` 을 출력한다.

## 범위 (bounds)

- 요청 1~3개. 각 요청은 기기 `A`, `B`, 또는 기기 없음 (3^n 조합, 총 39 시나리오).
- 매 스텝에서 "다음 요청 도착" 또는 "실행 중인 핸들러 하나를 성공/실패로 완료" 중 하나를 고른다. 모든 선택 조합을 탐색한다 (완료 경로 2706).
- 검사하지 않는 것: 4개 이상의 요청, 3개 이상의 기기, 핸들러가 동기적으로 throw 하는 경우(모두 `async`), HTTP 전송 계층, 백엔드 자체의 동시성. 범위 안 통과는 범위 안 보장이다.

## 불변식 (검사 파일의 번호와 같음)

1. 핸들러는 요청당 정확히 한 번 호출된다.
2. FIFO: 같은 기기의 시작 순서는 도착 순서의 접두사다.
3. 겹침 없음: 같은 기기에서 실행 중인 핸들러는 최대 1개.
4. 진행·격리: 같은 기기에 대기 요청이 있으면 그 기기의 핸들러가 정확히 1개 실행 중이다 (다른 기기 상태와 무관).
5. 기기 없는 호출은 도착 즉시 실행된다.
6. 종료 후 응답이 핸들러 결과와 일치하고(`result` 또는 `-32603` + 메시지), `locks` 맵이 비어 있다.

## 결과 읽기

실패 메시지는 `<불변식>(<기기>): 경로 [...] devices=[...] started=[...]` 형식이다. `경로` 는 코드의 말로 된 반례다: `arrive` 는 `handle()` 호출, `settle idx ok` 는 그 요청의 핸들러 완료. 예: `교착/격리 위반(A): 경로 [arrive, arrive, settle 0 fail] devices=[A,A] started=[0]` 는 "A 로 두 호출이 오고 첫 핸들러가 실패하자 두 번째가 영영 시작되지 않았다" 다.

- **실제 버그:** 반례가 코드 변경으로 설명되면 (`serialized` 의 `.catch`, 체인 연결, 잠금 삭제를 건드렸는지 본다). 속성이나 불변식을 약화시키지 말고 코드를 고친다.
- **검사 오류:** 의도한 계약 변경(예: 기기 없는 호출도 직렬화하기로 결정)이면 spec 을 먼저 고치고 그 불변식을 갱신한다. `flush()` 가 모자라 "시작 안 됨" 으로 보이는 경우는 `setImmediate` 반복 횟수를 늘려 확인한다.

## 실패 가능성 입증 (2026-11-07, 커밋 0afc66c 기준)

세 가지 고의 손상이 각각 잡혔다 (모두 되돌림):

| 손상 (`rpc.ts`) | 잡은 불변식 | 반례 |
| --- | --- | --- |
| `prev.catch(() => {}).then(fn)` → `prev.then(fn)` | 4 진행 | `[arrive, arrive, settle 0 fail] devices=[A,A]` |
| `serialized(...)` 우회, 핸들러 직접 호출 | 3 겹침 | `[arrive, arrive] devices=[A,A] started=[0,1]` |
| `locks.delete` 제거 | 6 잠금 누수 | `[arrive, settle 0 ok]` |

## 커버리지 기록과 동기화 커밋

| 검사가 설명하는 코드 | 파일 |
| --- | --- |
| `RpcDispatcher.handle` (deviceId 추출, 직렬화 분기, 오류 변환) | `packages/device-layer/src/rpc.ts` |
| `RpcDispatcher.serialized` (체인, catch, 잠금 정리) | `packages/device-layer/src/rpc.ts` |
| `RPC_ERRORS.internal` | `packages/device-layer/src/rpc.ts` |

- **sync commit: `9f506dc`** (2026-11-07). `0afc66c` 이후 `rpc.ts` 변경은 `RPC_ERRORS.helperUnavailable` 상수 추가뿐으로 `handle`/`serialized` 는 그대로다. 검사 재실행 통과 확인 후 옮김.
- 다음 에이전트: `git diff 0afc66c -- packages/device-layer/src/rpc.ts` 가 비어 있지 않으면 검사가 아직 코드를 설명하는지 다시 읽는다. 검사를 돌려 통과하고 불변식이 여전히 코드의 의도와 같다고 확인한 뒤에만 이 커밋 해시를 앞으로 옮긴다. 통과만으로 옮기지 않는다.
- `createDeviceServer` (`server.ts`) 는 이 디스패처 위에 핸들러를 등록할 뿐 직렬화 논리가 없어 범위 밖이다. 거기에 자체 큐나 잠금이 생기면 범위에 넣는다.

## 다음 후보

제어 평면 Ingest 의 이벤트 멱등 저장(`eventId` 중복·순서 뒤바뀜)이 생기면 같은 방식의 전수 검사 대상이다. `/pstack:maintain-formal-verification-skill` 로 변경 뒤 재정렬한다.
