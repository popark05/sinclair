# 헬퍼 APK 배포 경로 — 새 기기도 에이전트가 혼자 준비한다

mobile 엔진은 USB 를 건드리기 전에 헬퍼 APK 를 `--helper-apk` → `SINCLAIR_AGENT_HELPER_APK` → 번들(`apps/runner-agent/resources/helper/sinclair-helper-<V>.apk`) → 리포 디버그 빌드 → `SINCLAIR_AGENT_HELPER_URL` 다운로드(sha256 사이드카 검증, 캐시) 순으로 찾고, 어디서 찾았는지 로그에 남긴다. 헬퍼가 없는 기기는 온보딩(설치 → 토큰 → 접근성 활성화 `--user 0`)이 자동으로 끝난다.

## Sub-features

- `apk-resolve-order` 해석 순서와 각 단계 실패 사유(단위 테스트 `helper-apk.test.ts`).
- `apk-download-verify` 사이드카 없으면 받지 않음, 체크섬 불일치 거부, 캐시 적중 시 네트워크 없음(단위 테스트).
- `apk-missing-blocked` 어디서도 못 찾으면 USB 전에 `HelperApkError` → run 은 blocked(2), 로그에 모든 사유(`engines.test.ts`).
- `apk-reinstall-device` 헬퍼를 지운 실기기에서 run 이 설치부터 통과까지(실기기 opt-in).

## How to get to it (user POV)

새 기기를 꽂고 `sinclair-agent run --device <serial> …` 또는 데몬을 띄우면 끝. 사내 노드는 `SINCLAIR_AGENT_HELPER_URL=<릴리스 디렉터리 URL>` 과 `NODE_EXTRA_CA_CERTS` 만 설정한다.

## Driving it with scripts

```bash
# 해석 로그만 보기(기기 없이): 없는 파일을 지정하면 다음 단계로 넘어가는 사유가 찍힌다
node apps/runner-agent/bin/sinclair-agent.mjs run --control-plane http://127.0.0.1:1 --cycle x --target a --tests apps/runner-agent/test/fixtures/only-login --helper-apk /no/such.apk; echo "exit=$?"
# → "flag: /no/such.apk 없음" 뒤 번들/리포 빌드/다운로드 사유, 기기 없으면 exit 2

# 실기기 재설치 증명
adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_TEST_REINSTALL=1 npx vitest run apps/runner-agent/test/helper-reinstall.device.test.ts
# → .scratch/runner-agent/evidence/05-helper-reinstall-device-latest.json (exit 0, verified, "헬퍼 APK: … (repo-build|…)", "헬퍼 ready")
```

## Gotchas

- 릴리스 저장소에는 `sinclair-helper-<V>.apk` 와 `.sha256` 둘 다 있어야 한다. 사이드카가 없으면 에이전트는 APK 를 받지 않는다(검증 불가).
- 에이전트의 `HELPER_APK_VERSION` 과 헬퍼 `versionName` 을 같이 올린다(android-helper README "릴리스").
- 캐시는 `OS 데이터 디렉터리/sinclair/cache/helper`. 캐시가 사이드카와 다르면 다시 받는다.
