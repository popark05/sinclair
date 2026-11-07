# 03: 접근성 헬퍼 APK가 /ping과 /dump로 UI 트리를 준다

**What to build:** 독자 구현한 Android 접근성 서비스 APK를 기기에 설치하고 서비스를 켜면, localhost HTTP로 `/ping`과 `/dump`에 응답한다. `/dump`는 화면의 접근성 트리를 `@ref`가 붙은 `SemanticNode` JSON으로 돌려준다. 수동 설치 + `adb forward` + curl로 시연한다.

**Blocked by:** None (01, 02와 병렬 가능)

**Status:** done

- [x] 워크스페이스 안에 Android 프로젝트(접근성 서비스 + HTTP 서버)가 있고 gradle로 APK가 빌드된다. artemis 코드를 복사하지 않고 설계만 참고한다
- [x] 호스트가 브로드캐스트로 넘긴 세션 토큰이 없거나 다르면 모든 요청이 401이다
- [x] `/dump`의 각 노드는 `packages/protocol`의 `SemanticNode`(ref, role, name, bounds 등)와 일치하고, 계약 테스트가 샘플 JSON으로 이를 고정한다
- [x] UiAutomation을 쓰지 않아 다른 자동화 도구와 공존한다(서비스 선언에서 확인)
- [x] 빌드·설치·활성화 절차가 패키지 README에 적혀 있고, 그대로 따라 하면 curl로 트리가 나온다

## Comments

- 2026-11-07: 완료. `packages/device-layer/android-helper` (Gradle 9.5 + AGP 9.3, Java, 의존성 0). 실기기 SM-N981N(API 33)에서 설치 → `settings put --user 0` 활성화 → forward → 토큰 없음 401, 틀린 토큰 401, `/ping` 200, `/nope` 404, `/dump` 200(21노드, testId 16개) 확인. `/dump` 실기기 샘플을 `packages/protocol/test/fixtures/helper-dump.sample.json` 로 저장해 계약 테스트 3개로 고정. 발견: Secure Folder 가 있는 Samsung 은 `settings put` 에 `--user 0` 이 필요(없으면 사용자 150 에 쓰여 서비스가 안 켜짐). 04번 온보딩 자동화에 반영할 것.
