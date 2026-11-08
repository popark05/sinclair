# 03: 설치본 실기기 검증과 사내망 절차 (`verify-install` 스킬)

**What to build:** 리포 밖에 푼 macOS 배포본에서 실제 Android 기기를 꽂고 `bin/sinclair-agent run --device <serial> …` 을 치면 **번들에 든 헬퍼 APK** 로 온보딩이 끝나고 설정 앱 샘플이 통과해 배포본의 control-plane 에 `verified` 로 집계된다. 사내망 SSL 인터셉션 환경을 흉내 내어(자체 CA 의 로컬 HTTPS 릴리스 서버) `NODE_EXTRA_CA_CERTS` 로 헬퍼 다운로드 경로도 동작함을 증명한다. intent 의 "설치된 빌드에서 동작" 제약을 처음으로 실제로 닫는다.

**Blocked by:** 02 (배포본)

**Status:** done

- [x] `verify-install` 검증 스킬: 배포본 조립 → 임시 디렉터리에 풀기 → 서버 기동 → 에이전트 run(fake 와 실기기) → 증거 → 정리. 모든 명령은 설치본의 실행 스크립트로만(리포의 `pnpm` 명령 금지)
- [x] 실기기 증거: 헬퍼를 지운 기기에서 번들 APK(`resources/helper`, source `bundled`)로 설치·활성화·통과. 시리얼·홈 디렉터리 마스킹
- [x] 사내망 흉내: 자체 서명 CA 로 띄운 로컬 HTTPS 릴리스 서버에서 `NODE_EXTRA_CA_CERTS` 없이는 실패, 있으면 다운로드 성공(source `download`)을 증거로
- [x] 설치·업그레이드(같은 데이터 디렉터리 유지: DB·스풀·캐시)·제거 절차와 데이터 디렉터리 위치를 README 에 쓴다. 업그레이드 뒤 기존 SQLite DB(스키마 버전 2)가 그대로 열린다는 것을 테스트로
- [x] 알려진 한계(서명 없음, Windows 는 04)를 기록

## Comments

- 2026-11-08: 완료. `verify-install` 스킬(`.claude/skills/verify-install/`): `build.sh`(실제 `pnpm dist` — fetchNode 로 Node 24.13.0 다운로드·SHASUMS256 검증(캐시) → zip 을 `$RUN/install/` 에 풀고 `node/node --version` 기록), `start.sh`/`doctor.sh`(동봉 Node 버전 = VERSION 확인)/`stop.sh`, `run-fake.sh`, `ca-check.sh`(openssl 자체 CA + 127.0.0.1 서버 인증서, 동봉 Node 로 `release-server.mjs` HTTPS 릴리스, `SINCLAIR_RESOURCES_DIR` 빈 디렉터리로 번들 비활성 → `NODE_EXTRA_CA_CERTS` 없이 "download: sha256 사이드카 … 실패" blocked(2), 있으면 `(download)`), `upgrade-check.sh`(zip 을 다른 디렉터리에 다시 풀어 같은 DB 로 기동 → 같은 run), `run-device.sh`(`adb uninstall` → `adb kill-server` → 설치본 에이전트가 번들 APK 로 온보딩). 모든 구동은 설치본 `bin/` 런처로만. 설치본 README 에 설치·데이터 디렉터리·업그레이드·제거·알려진 한계 절 추가(dist.mjs), dist.test 에 업그레이드(복사본 설치 디렉터리 + 같은 DB)와 README 절 테스트. 증거 `.scratch/packaging/evidence/03-install-latest.json`: node v24.13.0, fake verified, CA 없이 2/있으면 (download), upgrade same, **실기기** SM-N981N 에서 `uninstall: Success` → `(bundled)` → 설치됨 → 활성화 재시도 1·2 → 활성화됨 → ready → verified(시리얼·홈 마스킹). intent 의 "설치된 빌드에서 동작" 제약을 실기기로 처음 닫음.
- 스크립트에서 잡은 것: RUN 은 절대 경로(런처를 /tmp 에서 실행), 백그라운드 서버는 stdin/stdout/stderr 를 떼어 호출자 파이프에 매달리지 않게, `exec` 로 pid 파일이 서버 자신을 가리키게(아니면 stop 이 껍데기만 죽이고 서버가 고아로 남음), 업그레이드 검사는 빈 응답이 통과하지 않도록 runId 확인.
