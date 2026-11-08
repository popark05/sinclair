---
name: verify-install
description: "Sinclair 설치본(release/sinclair-<version>-<target>.zip)이 리포 밖에서 동봉 Node 로 동작함을 증명한다: 조립(실제 Node 다운로드·검증) → 임시 디렉터리에 풀기 → 설치본 런처만으로 서버·에이전트(FakeEngine, 실기기 번들 APK)·사내망 CA(자체 CA HTTPS 릴리스)·업그레이드(같은 DB) 를 구동하고 증거를 남긴다. 패키징·번들·자산 경로·런처·README 를 바꿨을 때, 또는 '설치본이 실제로 도는지 보여 달라'는 요청에 쓴다."
---

# verify-install

intent 의 제약 "설치된 macOS/Windows 빌드에서 동작(dev 모드만으로 검증 금지)" 을 닫는 스킬. 모든 구동은 **설치본의 `bin/` 런처**로만 하고, 리포의 `pnpm`/`npx` 는 조립(`build.sh`)에만 쓴다. `adb` 는 헬퍼 제거·기기 식별·`kill-server` 에만 쓴다(기기 도구, 리포 코드 아님). 스크립트는 리포 루트에서 실행한다(`run-device.sh` 가 리포의 설정 앱 샘플 테스트를 복사한다).

```bash
S=.claude/skills/verify-install/scripts
RUN=$PWD/.e2e/verify-install/$(date +%Y%m%d-%H%M%S)-<목적>     # 절대 경로(런처는 /tmp 에서 실행)
```

## Launch

```bash
$S/build.sh $RUN      # pnpm dist → $RUN/release/*.zip → $RUN/install/<name>/ ; INSTALLED dir=… node=v24.x.y
$S/start.sh $RUN      # 설치본 런처로 control-plane(sqlite, DB=$RUN/data/control-plane.db); READY 줄 → $RUN/server.json
$S/daemon-fake.sh $RUN   # 설치본 데몬 → 워커 프로세스로 run → DAEMON exit=0 finished/verified workerLines≥1 workersLeft=0
```

- 첫 조립은 nodejs.org 에서 Node 를 받는다(SHASUMS256 검증, `~/Library/Caches/sinclair/node` 캐시). 사내망이면 `NODE_EXTRA_CA_CERTS` 를 먼저 export. 두 번째부터는 네트워크 없음.
- 헬퍼 APK 리포 빌드(`android-helper` README)가 없으면 조립이 안내와 함께 실패한다.
- `install.json` 에 설치 디렉터리·zip·버전·동봉 Node 버전·zip 크기가 남는다.

## Doctor

```bash
$S/doctor.sh $RUN     # DOCTOR OK pid=… port=… node=v24.x.y  (pid 생존, /health 200, 동봉 Node 버전 = VERSION 파일)
```

## Drive

```bash
$S/run-fake.sh $RUN            # 설치본 에이전트 run --engine fake → FAKE exit=0 finished/verified
$S/ca-check.sh $RUN            # 자체 CA HTTPS 릴리스 서버: CA 없이 exit=2 "download: sha256 사이드카 …", CA 있으면 "(download)"  (기기 불필요)
$S/upgrade-check.sh $RUN       # 서버 내리고 zip 을 다른 디렉터리에 다시 풀어 같은 DB 로 기동 → UPGRADE OK (서버는 새 디렉터리로 다시 떠 있음)
$S/run-device.sh $RUN [serial] # adb uninstall 헬퍼 → adb kill-server → 설치본 에이전트가 번들 APK 로 온보딩 → DEVICE exit=0 finished/verified apk=bundled
```

레시피는 `features/` 에 있다. 먼저 `features/README.md` 를 읽는다.

## Evidence

위치: `$RUN/evidence/install-{fake,ca,upgrade,device}.json`, `$RUN/install.json`, `$RUN/server.out`, `$RUN/build.out`.

증명 기준:
- 설치본 런처로 실행했고 `install.json`/`doctor` 의 동봉 Node 버전이 VERSION 과 같다(개발 Node 가 아님).
- 실기기 증거는 `uninstall: "Success"` → `헬퍼 APK: … (bundled)` → `헬퍼 설치됨` → `접근성 서비스 활성화됨` → `헬퍼 ready` → `verified` 순서가 모두 있어야 "설치부터" 가 증명된다. 시리얼·홈 디렉터리는 마스킹한다.
- 사내망 증거는 두 실행이 함께 있어야 한다(CA 없이 실패 사유 + CA 로 download).
- 요약은 `.scratch/packaging/evidence/03-install-latest.json` 에 남긴다.

## Cleanup

```bash
$S/stop.sh $RUN       # 우리가 띄운 서버만 SIGTERM. $RUN 은 남긴다(.e2e 는 git-ignore)
```

## Helpers

| 스크립트 | 역할 |
| --- | --- |
| `build.sh <RUN>` | `pnpm dist` 호스트 타깃 조립 + 풀기 + `install.json` |
| `daemon-fake.sh <RUN>` | 설치본 데몬이 run 을 워커 프로세스(`__worker`)로 돌림: verified, 로그에 워커 표시, 끝난 뒤 워커 0 (device-fleet 04) |
| `start.sh` / `doctor.sh` / `stop.sh` | 설치본 서버 수명 |
| `run-fake.sh` | FakeEngine run → verified |
| `ca-check.sh` | openssl 자체 CA + `release-server.mjs`(동봉 Node 로 HTTPS) → `NODE_EXTRA_CA_CERTS` 유무 비교 |
| `upgrade-check.sh` | 같은 DB 로 새 설치 디렉터리 기동 |
| `run-device.sh [serial]` | 실기기: 헬퍼 제거 → 번들 APK 온보딩 → 통과 |
