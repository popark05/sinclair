# Cycle 생성·Run 등록·Verdict

Cycle 을 만들고 타깃별 Run 을 등록한 뒤, 그 runId 로 들어온 이벤트가 `GET /cycles/:id` 의 TestCase × 타깃 매트릭스와 Verdict 로 집계된다.

## Sub-features

- `cycle-create` `POST /cycles` 201(cycleId 발급 또는 지정), 400(build/targets 누락), 409(중복 cycleId).
- `cycle-run-register` `POST /cycles/:id/runs` 201(runId 발급), 400(targets 밖의 타깃), 404(모르는 Cycle), 409(중복 runId).
- `cycle-incomplete` 일부 run 만 끝나면 `state: running`, `verdict: incomplete`, 매트릭스에 끝난 타깃만.
- `cycle-flaky` 재시도 끝 통과는 `passed-flaky`, 마지막 attempt 는 `attemptNo` 최대.
- `cycle-verified` 전부 끝나고 필수 케이스가 모두 통과면 `finished` + `verified`.

## How to get to it (user POV)

QA 담당자가 Console(또는 API)로 Cycle 을 만들고, Scheduler/runner-agent 가 타깃별 Run 을 등록해 그 runId 로 러너를 돌린다. Console 은 `GET /cycles/:id` 로 매트릭스를 그린다.

## Driving it with scripts

```bash
$S/cycle.sh $RUN cycle
# → {"cycleId":"verify-cycle-…","state":"finished","verdict":"verified","matrix":{"로그인 > 아이디로 로그인한다":{"android":{"verdict":"passed",…},"ios":{"verdict":"passed-flaky","attemptId":"ios-a2"}}}}
# 증거: evidence/cycle-create.json(201), cycle-run-android/ios.json(201), cycle-view-mid.json(running/incomplete), cycle-view-final.json(finished/verified)
```

오류 경로는 `ingest.sh` 대신 curl 로 직접: `curl -s -X POST http://127.0.0.1:<port>/cycles -d '{"build":"b","targets":[]}'` → 400.

## Gotchas

- 러너는 아직 재시도(attemptNo 2)를 내지 않는다. ios run 의 재시도 이벤트는 스크립트가 손으로 만든다.
- 필수 태그는 테스트 이름의 `@태그` 토큰이다. `requiredTags` 가 비면 모든 케이스가 필수라, 타깃이 둘인데 한 타깃에서만 돈 케이스는 `verified` 가 아니다.
- cycleId 는 `verify-cycle-<epoch>-<pid>` 라 같은 서버에서 여러 번 돌려도 409 가 나지 않는다.
