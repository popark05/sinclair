# run 하나 실행

`sinclair-agent run` 이 Cycle 에 Run 을 등록하고 테스트 디렉터리의 `*.sinclair.ts` 를 엔진으로 돌려 HTTP Reporter 로 보고한 뒤 종료 코드로 결과를 알린다.

## Sub-features

- `run-ok` 통과만 있으면 exit 0, Cycle `finished/verified`.
- `run-failed` 실패가 있으면 exit 1, Cycle `blocked`, 매트릭스에 `failed` 셀.
- `run-config` 필수 인자 누락·모르는 Cycle·끝난 Cycle 은 exit 3 과 메시지, Run 등록 없음.
- `run-blocked` 기기 불가는 exit 2, run `infra-failed`(실기기 또는 단위 테스트로).

## How to get to it (user POV)

QA 담당자가 Cycle 을 만들고 기기 노드에서 `sinclair-agent run --control-plane <url> --cycle <id> --target <id> --tests <dir> [--device <serial>]` 을 친다. 결과는 `GET /cycles/:id` 와 종료 코드.

## Driving it with scripts

```bash
$S/run-fake.sh $RUN                                           # AGENT exit=0 … verdict=verified
$S/run-fake.sh $RUN agent-mixed-$$ apps/runner-agent/test/fixtures   # exit=1, verdict=blocked (실패 1 포함)
node apps/runner-agent/bin/sinclair-agent.mjs run --cycle x; echo "exit=$?"   # 3, 설정 오류: --control-plane
```

## Gotchas

- `--engine` 기본은 mobile 이라 기기 없이 실행하면 exit 2(엔진 준비 실패)다. 증명 스크립트는 `--engine fake` 를 쓴다.
- 혼합 픽스처의 실패 테스트는 locator 기한(기본 10초)만큼 기다린다. 빠르게 보려면 `--timeout 500`.
