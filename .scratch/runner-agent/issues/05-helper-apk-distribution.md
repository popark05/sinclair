# 05: 헬퍼 APK 배포 경로 — 새 기기도 에이전트가 혼자 준비한다

**What to build:** 헬퍼 APK 가 설치되지 않은 Android 기기를 꽂아도 `sinclair-agent run --device <serial>` 이 APK 를 찾아 설치하고 접근성 서비스를 켜서 테스트를 돌린다. APK 는 플래그 → 환경변수 → 에이전트 번들 리소스 → 릴리스 URL 다운로드(체크섬 검증, 사내망 CA) 순으로 찾고, 어디서 찾았는지 로그에 남긴다. android-backend 티켓에서 미룬 `helperApkPath` 확보를 닫는다.

**Blocked by:** 02 (run 실행 CLI)

**Status:** ready-for-agent

- [ ] APK 해석 순서와 각 단계의 실패 사유가 로그에 남는다. 다운로드는 SHA-256 으로 검증하고 캐시 디렉터리에 두며, 사내망 SSL 인터셉션 환경에서는 `NODE_EXTRA_CA_CERTS` 를 따른다(EverMock ApkManager 패턴, 코드 복사 없이)
- [ ] 찾은 경로를 Android 백엔드의 `helperApkPath` 로 넘겨 온보딩(설치 → 토큰 → 접근성 서비스 활성화, `--user 0`)이 자동으로 끝난다. 없으면 run 은 blocked(종료 코드 2) 와 명확한 메시지
- [ ] 헬퍼 APK 빌드 산출물을 릴리스 아티팩트로 내는 절차(버전·체크섬 파일)와 에이전트가 기대하는 버전 고정이 문서화된다
- [ ] 테스트: 페이크 HTTP 로 다운로드·체크섬 불일치·캐시 적중을 검증, 해석 순서 표 테스트
- [ ] 실기기 증거: 헬퍼를 지운 기기에서 `run` 이 설치부터 통과까지 흐른 로그(시리얼 마스킹)를 `.scratch/runner-agent/evidence/` 에 남긴다
