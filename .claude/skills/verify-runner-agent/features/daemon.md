# 데몬: 사람 개입 없이 Cycle 매트릭스가 채워진다

`sinclair-agent daemon --targets <a,b>` 가 control-plane 에서 자기 타깃의 대기 중인 Run 을 클레임해 Cycle 의 suite 로 실행·보고하고 다음을 가져온다. 같은 Run 은 하나의 에이전트만 잡고(lease), 에이전트가 죽으면 lease 만료 뒤 다른 에이전트가 가져간다.

## Sub-features

- `daemon-claim` 데몬 2개(각 타깃)가 Run 을 하나씩 잡아 Cycle 이 `finished/verified`, run 행의 `lease.agentId` 가 서로 다르다.
- `daemon-suite` Cycle 의 `suite.tests` 디렉터리를 쓴다(데몬의 `--tests` 는 suite 가 없을 때의 기본값).
- `daemon-stop` SIGTERM 에 "진행 중 run 을 마치고 멈춤" 뒤 exit 0.
- `daemon-lease-expiry` 만료된 lease 재클레임(단위 테스트 `daemon.test.ts` 로 증명; 스크립트는 시계를 못 돌린다).

## How to get to it (user POV)

기기 노드마다 `sinclair-agent daemon --control-plane <url> --targets android --tests <기본 디렉터리> --device <serial>` 을 띄워 두면, QA 담당자는 Cycle 과 Run 만 만들고 Console 에서 결과를 본다.

## Driving it with scripts

```bash
$S/daemon.sh $RUN
# DAEMON cycle=daemon-… state=finished verdict=verified leases=node-a,node-b exits=0,0
```

## Gotchas

- 데몬은 `--engine fake` 로 띄운다(기기 없음). 실기기는 `--engine mobile --device <serial>` 로 같은 명령.
- 데몬 로그(`$RUN/daemon-a.out`)에 "클레임", "결과:", "SIGTERM 수신", "데몬 종료" 가 순서대로 있어야 한다.
- lease TTL 은 서버 설정(기본 60초)이고 heartbeat 는 TTL/3 마다. 만료 재클레임은 단위 테스트에서 시계를 돌려 증명한다.
