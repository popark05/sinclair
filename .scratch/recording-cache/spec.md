# 녹화 캐시 (recording cache)

에이전트 `agent.act` 스텝이 실제로 한 액션을 의미 기술자(descriptor)로 기록해 두고, 다음 실행부터는 모델 없이 그대로 재생한다. 재생이 어긋나면 그 지점부터 에이전트가 이어받는다. 비용·시간을 줄이고, 같은 테스트를 결정적으로 만든다.

참고: `reference/e2e` 의 replay cache(설계만, 코드 복사 금지). 2026-11-14 조사 요약은 이 파일 끝 "참고에서 가져온 것".

## 결정 (2026-11-14, 사용자)

- **저장 위치**: control-plane 공유 저장(노드 하나가 녹화하면 플릿 전체가 재생). 저장소는 `CacheStore` 인터페이스로 교체 가능하게 두고, 먼저 로컬(메모리·파일) 구현 → control-plane 저장(SQLite)·HTTP 저장소 순서.
- **기본 모드**: 읽고 쓰기(`read-write`). `--cache off|read-only|read-write|strict`.
- **재탐색**: 정확히 하나 일치. 녹화한 정체 필드(역할·이름(없으면 글자)·testId·placeholder)가 모두 같은 노드가 현재 화면에 정확히 하나일 때만. 0개면 잠시 기다려 다시(상한), 둘 이상이면 곧바로 어긋남 → 이어받기. 가중치 점수(안전망의 `relocate`)는 쓰지 않는다.

## 범위

- 캐시하는 것: `agent.act` 만. `agent.assert`·`waitFor`·`extract` 는 늘 실제로 돈다 — 판정이 녹화를 확인하는 수단이라 판정을 재생하면 녹화가 스스로를 확인하게 된다.
- 기록하는 액션: 에이전트가 **성공적으로 실행한** 툴 호출(`tap`·`type`·`submit`·`scroll`·`back`). 거부·오류·안전망이 막은 호출, `done` 은 남기지 않는다. 자동 Incident 복구(권한 허용 등)는 기록하지 않는다 — 재생 때도 Incident 감지·복구가 그대로 돈다.
- `type` 의 글자는 그대로 기록하되, 비밀값은 자리표시(`{{secret:NAME}}`)로만 남기고 재생 때 그 실행의 비밀값으로 채운다. 화면에서 읽은 값을 입력한 경우는 구별하지 않는다(알려진 한계).

## 키

`sha256(canonical JSON)` 의 16진수 — 저장소 키이자 파일 이름.

`{ schema: 'rc-1', policy: 'exact/1', testId, platform, appId, instruction(정규화: CRLF→LF, NFC, trim), callIndex }`

- `callIndex`: 같은 테스트 안에서 같은 instruction 의 act 가 몇 번째인가(테스트 안 위치가 아니다 — 앞에 선택적 스텝이 끼어도 번호가 밀리지 않게).
- `appId`: 테스트가 연 앱(엔진이 아는 foreground 패키지, 모르면 빈 값).
- 모델·엔진 버전은 넣지 않는다(릴리스마다 캐시 전체가 식지 않게). 정책·스키마가 바뀌면 `schema`/`policy` 를 올려 전부 새로 녹화.
- 타깃(기기)은 넣지 않는다: 같은 앱이면 기기가 달라도 같은 녹화를 쓰고, 어긋나면 이어받는다.

## 항목 (CacheEntry)

```
{ schema, createdAt, recordedBy: { agentId?, deviceModel?, model? },
  start: { app?: string },                                  // 전제: 재생 시작 화면의 foreground 앱
  actions: Array<{ tool: 'tap'|'type'|'submit'|'scroll'|'back', target?: Target, text?: string, direction?: 'up'|'down', summary: string }>,
  end: { anchors: Target[] } }                              // 결과 화면에 새로 나타난 이름 있는 노드(최대 8)
Target = { role, label?, testId?, placeholder? }
```

상한: 액션 50개, 글자 4096자, 항목 64KiB.

## 기록 시점 (검증 뒤에만)

- act 가 성공(done)하면 항목을 **스테이징**한다. 테스트(Attempt)가 끝날 때, 그 act **뒤에 검증 스텝이 통과했으면** 커밋한다.
- 검증 스텝: locator `expect(...)` 통과, `agent.assert` 참, `agent.waitFor` 충족. (`extract`·다른 act·테스트 통과 자체는 아니다.)
- 테스트가 실패하면 그 뒤의 정리 스텝은 확인으로 치지 않는다. 확인되지 않은 스테이징은 버리고, 그 테스트에서 재생에 쓴 항목이 실패와 함께였다면 지운다(eviction). 모델에 닿지 못한 실패(`agent-config`·네트워크)·취소는 아무것도 지우지 않는다.
- 재생이 그대로 통과한 항목은 다시 쓰지 않는다(createdAt 유지).

## 재생

1. 키로 조회. 없으면 live(에이전트), `cache: 'live'`.
2. 전제: `start.app` 이 현재 foreground 앱과 다르면 live.
3. 액션마다: 관찰 → 대상 정확히 하나 찾기(0개면 100·300·600·1000ms 다시, 상한 3초) → 엔진 실행(엔진이 액션 뒤 화면 전환을 기다린다). `type` 은 자리표시를 이번 실행의 비밀값으로.
4. 끝: 모든 end anchor 가 현재 화면에 있어야 한다(상한 5초 폴링). 그리고 재생 전 화면과 달라졌어야 한다.
5. 모두 통과 → `cache: 'replayed'`, 모델 호출 0.

## 이어받기

- 어긋남(대상 없음·애매함·액션 오류·끝 anchor 불일치)이 **액션을 하나 이상 실행한 뒤** 나면, 그 화면에서 `runAct` 를 돌리되 목표 옆에 "이미 한 액션(요약)·멈춘 곳·이유, 다시 하지 말고 현재 화면에서 이어서" 를 알린다. `cache: 'handed-off'`. 에이전트가 끝까지 해내면 녹화를 처음부터(재생분 + 이어받은 분) 다시 스테이징.
- 첫 액션 전에 어긋나면 이어받기가 아니라 live(`cache: 'live'`, 사유 기록).

## 모드

| 모드 | 재생 | 기록·지우기 |
| --- | --- | --- |
| `off` | ✗ | ✗ |
| `read-only` | ✓ | ✗ |
| `read-write` (기본) | ✓ | ✓ |
| `strict` | ✓, 어긋나면 이어받지 않고 실패(errorCode `cache-stale`), 녹화 없으면 실패(`cache-miss`) | ✗ |

- 재시도 Attempt(attemptNo > 1)는 재생하지 않는다(기록만).

## 보고

- `step.recorded.cache`: `replayed | handed-off | recorded | live`(protocol 에 이미 있음). `recorded` 는 live 로 돈 뒤 커밋된 스텝 — 커밋은 Attempt 끝에 정해지므로 스텝 이벤트는 `live` 로 먼저 나가고, 커밋 결과는 Attempt 의 캐시 요약으로 남긴다(티켓 01 에서 확정).
- act 스텝 instruction 에 재생 표시: `act "…" → 재생 3/3` / `→ 재생 2/3 뒤 이어받음(사유) → …`.
- Console: Cycle 의 녹화 캐시 적중(재생·이어받음·live 스텝 수, 아낀 모델 호출 추정).

## 참고에서 가져온 것 (reference/e2e, 설계만)

act 만 캐시, 검증 뒤 Attempt 끝 커밋·실패 시 eviction, callIndex 를 instruction 반복 번호로, 모델·엔진 버전을 키에서 뺌, 정확히-하나 재탐색과 0개일 때 백오프, end anchor 로 기계적 사후 확인 + 재생이 변화를 만들었는지, 중간 이어받기에 재생한 접두부를 글로 전달, 재시도는 재생 안 함, strict 는 어긋나면 실패, 바뀌지 않은 항목은 다시 쓰지 않음, 저장소 인터페이스 `read/write/delete`.
