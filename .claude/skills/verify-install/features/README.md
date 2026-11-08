# install verification map

설치본(zip)의 운영자 관점 동작을 검증하는 유지 소스다. 기능 파일을 읽기 전에 이 인덱스를 먼저 읽는다.

## Baseline preconditions

- `S=.claude/skills/verify-install/scripts`, `RUN=$PWD/.e2e/verify-install/<timestamp>-<purpose>`(절대 경로).
- `$S/build.sh $RUN` 이 `INSTALLED` 를, `$S/start.sh $RUN` 이 `READY` 를, `$S/doctor.sh $RUN` 이 `DOCTOR OK` 를 출력했다.
- 리포의 Node 가 아니라 설치본의 `node/node` 가 돈다(doctor 가 확인).

## Driving conventions

- 서버·에이전트는 설치본 `bin/` 런처로만. `adb` 는 헬퍼 제거에만 쓰고 그 뒤 `adb kill-server`.
- 데이터는 `$RUN/data`, `$RUN/spool` 등 RUN 안에 둔다(설치 디렉터리에는 쓰지 않는다 — README 의 약속).

## Proof and skip reporting

- 증거 파일(`evidence/install-*.json`)의 `exitCode` 와 핵심 로그 줄을 인용한다.
- 실기기 증거가 없으면 "FakeEngine 경로만 증명" 이라고 쓴다. 기기 없이 `run-device.sh` 는 `DEVICE FAIL: 꽂힌 기기 없음` 으로 실패를 보고한다.

## Feature entry contract

각 기능 파일은 H1 제목과 한 문단 설명 뒤에 정확히 네 H2 를 이 순서로 가진다: `Sub-features`, `How to get to it (user POV)`, `Driving it with scripts`, `Gotchas`.

## Features

- `install.md` — 조립·풀기·런처·서버·FakeEngine run.
- `intranet-ca.md` — 사내망 CA 로 헬퍼 다운로드.
- `upgrade.md` — 새 설치 디렉터리 + 같은 DB.
- `device.md` — 실기기: 번들 APK 로 헬퍼 설치부터 통과까지.
