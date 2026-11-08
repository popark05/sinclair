# 05: 헬퍼 APK 배포 경로 — 새 기기도 에이전트가 혼자 준비한다

**What to build:** 헬퍼 APK 가 설치되지 않은 Android 기기를 꽂아도 `sinclair-agent run --device <serial>` 이 APK 를 찾아 설치하고 접근성 서비스를 켜서 테스트를 돌린다. APK 는 플래그 → 환경변수 → 에이전트 번들 리소스 → 릴리스 URL 다운로드(체크섬 검증, 사내망 CA) 순으로 찾고, 어디서 찾았는지 로그에 남긴다. android-backend 티켓에서 미룬 `helperApkPath` 확보를 닫는다.

**Blocked by:** 02 (run 실행 CLI)

**Status:** done

- [x] APK 해석 순서와 각 단계의 실패 사유가 로그에 남는다. 다운로드는 SHA-256 으로 검증하고 캐시 디렉터리에 두며, 사내망 SSL 인터셉션 환경에서는 `NODE_EXTRA_CA_CERTS` 를 따른다(EverMock ApkManager 패턴, 코드 복사 없이)
- [x] 찾은 경로를 Android 백엔드의 `helperApkPath` 로 넘겨 온보딩(설치 → 토큰 → 접근성 서비스 활성화, `--user 0`)이 자동으로 끝난다. 없으면 run 은 blocked(종료 코드 2) 와 명확한 메시지
- [x] 헬퍼 APK 빌드 산출물을 릴리스 아티팩트로 내는 절차(버전·체크섬 파일)와 에이전트가 기대하는 버전 고정이 문서화된다
- [x] 테스트: 페이크 HTTP 로 다운로드·체크섬 불일치·캐시 적중을 검증, 해석 순서 표 테스트
- [x] 실기기 증거: 헬퍼를 지운 기기에서 `run` 이 설치부터 통과까지 흐른 로그(시리얼 마스킹)를 `.scratch/runner-agent/evidence/` 에 남긴다

## Comments

- 2026-11-08: 완료. `apps/runner-agent/src/helper-apk.ts` `resolveHelperApk`: `--helper-apk` → `SINCLAIR_AGENT_HELPER_APK` → 번들(`apps/runner-agent/resources/helper/sinclair-helper-<V>.apk`) → 리포 디버그 빌드(개발용) → `SINCLAIR_AGENT_HELPER_URL/sinclair-helper-<V>.apk` 다운로드. 다운로드는 `.sha256` 사이드카를 먼저 받아 검증 가능할 때만 받고, 불일치는 거부(캐시에 안 남김), 캐시(`OS 데이터 디렉터리/sinclair/cache/helper`)에 APK + 사이드카를 함께 둬 다음 run 은 네트워크 없이 쓴다. 단계마다 실패 사유를 모아 로그·오류에 남긴다. 고정 버전 `HELPER_APK_VERSION = '0.1.0'`. `engines.ts` 는 USB 전에 해석하고 `helperApkPath` 로 넘긴다; 못 찾으면 `HelperApkError` → run blocked(2) + infra-failed 보고. 기기 목록은 USB 인터페이스가 막 풀린 직후 잠깐 비므로 0.5초 × 6 재시도. android-helper README 에 "릴리스" 절(파일명·sha256·업로드·버전 고정). 테스트: 해석 표·다운로드·검증·캐시 5개, `createEngine` 사유 수집 1개, args. `verify-runner-agent` 에 `features/helper-apk.md`.
- 실기기: `pm uninstall` 로 헬퍼를 지운 SM-N981N 에서 run 이 설치 → 활성화 → 통과(16초), evidence `05-helper-reinstall-device-latest.json`(시리얼 마스킹). 그 과정에서 **발견**: 막 설치한 접근성 서비스는 첫 `settings put` 이 무시된다(접근성 관리자가 모르는 컴포넌트를 목록에서 지움) → 백엔드 온보딩이 1초 간격 5회 재시도(`ACTIVATE_RETRIES`), CLAUDE.md 알려진 실수에 추가. 또 **발견·수정**: 같은 스풀 디렉터리를 쓰는 데몬 둘 중 하나의 시작 시 `resumeSpool` 이 다른 데몬의 진행 중 스풀을 보내고 지워 버리는 경쟁 → 스풀 Reporter 가 `<runId>.lock`(pid) 을 잡고 resume 은 살아 있는 pid 의 스풀을 건너뛴다(죽은 pid 의 lock 은 무시) + 테스트.
- 결정: 사이드카 없는 릴리스는 받지 않는다(검증 불가). `Dadb` 를 device-layer 공개 API 로 export(테스트와 고급 사용). 번들 디렉터리는 비어 있고(패키징 티켓에서 채움) 지금은 리포 빌드가 개발 기본값.
- 2026-11-08 리뷰 반영(Standards + Spec): (1) 증거가 "설치부터" 를 증명하도록: `pm uninstall` 출력(`Success`)과 백엔드 온보딩 단계(`onHelperStep`: 설치 중/설치됨/활성화 재시도 n/활성화됨/준비됨 v)를 로그·증거에 포함, 홈 디렉터리·리포 경로·임시 경로 마스킹(사용자명 노출 제거). (2) 실기기 테스트가 리포 빌드를 로컬 "릴리스 서버" 로 띄워 **다운로드 경로**(사이드카 검증 → 캐시)를 실제로 탄다(증거 `(download)`). (3) fetch 에 30초 timeout. (4) `resolveHelperApk` 를 `findLocal`/`cacheVerifies`/다운로드로 나누고 throw 중복 제거, `defaultDataDir` 공용화. (5) 활성화 재시도를 `helperActivate` 옵션으로 주입 가능하게 하고 페이크(`ignoreFirstAccessibilityPuts`)로 "첫 put 무시 → 재시도 성공" 단위 테스트, 기존 disabled 테스트는 재시도 2회로 단축. (6) `HelperApkError` 는 "헬퍼 APK 없음(기기 불가)" 접두어. (7) 스풀 lock 의 Windows/pid 재사용 한계 주석. (8) 엔진 준비에 `KEYCODE_HOME` + "헬퍼 트리가 찰 때까지" 대기 추가(막 켜진 서비스는 창 이벤트 전까지 빈 트리). README 에 같은 버전 재릴리스 주의. 미해결 관찰: 재설치 직후 두 번은 설정 앱 관찰이 비어 실패했으나(온보딩은 모두 성공) 이후 같은 테스트가 연속 3회 통과, 직접 probe 도 정상 — 원인 미확인(일시적 기기 상태로 추정), 재현되면 조사. 미반영: 리포 빌드 단계가 다운로드 앞에 있어 개발 머신에서는 다운로드가 돌지 않는 점은 테스트로 보완(설계 유지, 개발 편의); `tags` 필터링·번들 디렉터리 채우기는 패키징 티켓.
