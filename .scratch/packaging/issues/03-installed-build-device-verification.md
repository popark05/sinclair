# 03: 설치본 실기기 검증과 사내망 절차 (`verify-install` 스킬)

**What to build:** 리포 밖에 푼 macOS 배포본에서 실제 Android 기기를 꽂고 `bin/sinclair-agent run --device <serial> …` 을 치면 **번들에 든 헬퍼 APK** 로 온보딩이 끝나고 설정 앱 샘플이 통과해 배포본의 control-plane 에 `verified` 로 집계된다. 사내망 SSL 인터셉션 환경을 흉내 내어(자체 CA 의 로컬 HTTPS 릴리스 서버) `NODE_EXTRA_CA_CERTS` 로 헬퍼 다운로드 경로도 동작함을 증명한다. intent 의 "설치된 빌드에서 동작" 제약을 처음으로 실제로 닫는다.

**Blocked by:** 02 (배포본)

**Status:** ready-for-agent

- [ ] `verify-install` 검증 스킬: 배포본 조립 → 임시 디렉터리에 풀기 → 서버 기동 → 에이전트 run(fake 와 실기기) → 증거 → 정리. 모든 명령은 설치본의 실행 스크립트로만(리포의 `pnpm` 명령 금지)
- [ ] 실기기 증거: 헬퍼를 지운 기기에서 번들 APK(`resources/helper`, source `bundled`)로 설치·활성화·통과. 시리얼·홈 디렉터리 마스킹
- [ ] 사내망 흉내: 자체 서명 CA 로 띄운 로컬 HTTPS 릴리스 서버에서 `NODE_EXTRA_CA_CERTS` 없이는 실패, 있으면 다운로드 성공(source `download`)을 증거로
- [ ] 설치·업그레이드(같은 데이터 디렉터리 유지: DB·스풀·캐시)·제거 절차와 데이터 디렉터리 위치를 README 에 쓴다. 업그레이드 뒤 기존 SQLite DB(스키마 버전 2)가 그대로 열린다는 것을 테스트로
- [ ] 알려진 한계(서명 없음, Windows 는 04)를 기록
