# 설치본 조립·실행

zip 을 풀면 `bin/` 런처만으로 서버와 에이전트가 동봉 Node 로 돈다.

## Sub-features

- `install-build` `pnpm dist` 가 Node 를 받아 검증하고 zip 을 만든다(두 번째부터 캐시).
- `install-node` 설치본의 `node/node --version` 이 VERSION 의 node 와 같다.
- `install-server` 런처로 서버가 sqlite 기본으로 READY, `/health` 200.
- `install-fake` 런처로 에이전트 `run --engine fake` 가 verified.

## How to get to it (user POV)

QA 담당자가 zip 을 풀고(`xattr -dr com.apple.quarantine`) `bin/sinclair-control-plane` 과 `bin/sinclair-agent` 를 친다.

## Driving it with scripts

```bash
$S/build.sh $RUN && $S/start.sh $RUN && $S/doctor.sh $RUN && $S/run-fake.sh $RUN
# INSTALLED … node=v24.13.0 / READY … / DOCTOR OK … / FAKE exit=0 finished/verified
```

## Gotchas

- RUN 은 절대 경로여야 한다(런처는 /tmp 에서 실행해 설치본이 cwd 에 의존하지 않음을 함께 본다).
- 첫 조립은 nodejs.org 네트워크가 필요하다. 사내망은 `NODE_EXTRA_CA_CERTS`.
