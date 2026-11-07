# Sinclair Android Helper (접근성 헬퍼 APK)

디바이스 레이어의 Android 백엔드가 말을 거는 온디바이스 에이전트. 접근성 서비스로 동작하며 **UiAutomation 을 쓰지 않아** Appium/Espresso/Maestro 와 공존한다(ADR 0003). 외부 의존성 없이 `android.accessibilityservice`, `android.view.accessibility`, `org.json` 만 쓴다. 설계는 artemis 의 접근성 헬퍼를 참고했고 코드는 독자 구현이다.

- 패키지 `io.sinclair.helper`, 서비스 `.SinclairAccessibilityService`, minSdk 26, targetSdk 36.
- 서비스가 켜지면 `127.0.0.1:38300` 에 HTTP 서버를 띄운다. 호스트는 `adb forward` 로 접근한다.
- 모든 요청은 `Authorization: Bearer <token>` 이 필요하다. 토큰은 `WRITE_SECURE_SETTINGS` 권한으로 보호된 브로드캐스트로만 설정할 수 있어(= adb shell 만), 기기 안의 다른 앱이 서버에 접근할 수 없다.

## 라우트

| 경로 | 응답 |
| --- | --- |
| `GET /ping` | `{"ok":true,"version":"0.1.0","sdk":33,"service":"ready"}` |
| `GET /dump` | 활성 창의 접근성 트리. `packages/protocol` 의 `SemanticNode`(루트 객체). `ref` 는 이 dump 안에서만 유효한 DFS 순번 `@e0…` |
| 그 외 | 404. 토큰 없음/불일치 401, GET 외 405 |

`/dump` 의 노드: `ref`, `role`(className 과 clickable 로 결정: button/textbox/checkbox/switch/radio/image/text/list/scrollable/webview/slider/combobox/tab/group/view), `name`(contentDescription), `text`(보이는 글자) 또는 `value`(textbox 의 입력 내용, slider 의 현재값), `testId`(resource-id), `placeholder`(hint), `rect`(화면 좌표, 정수), `states`(true 인 것만: focused/selected/checked/disabled/secure), `children`(화면에 보이는 자식만). 비밀번호 필드의 `value` 는 비운다. 활성 창이 없으면 `role: view`, 크기 0 인 노드 하나를 돌려준다. 계약 테스트: `packages/protocol/test/helper-dump.contract.test.ts` (실기기 샘플 `fixtures/helper-dump.sample.json`).

## 빌드

```bash
cd packages/device-layer/android-helper
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=$HOME/Library/Android/sdk \
  ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk (약 0.9 MB)
```

Gradle 9.5 + AGP 9.3 (래퍼 포함). 처음 한 번은 `aapt2` 등을 받기 위해 네트워크가 필요하고, 그 뒤로는 `--offline` 으로 빌드된다. 사내망이면 JVM 트러스트스토어가 사내 CA 를 신뢰해야 한다(Android Studio 의 JBR 은 보통 된다).

## 릴리스 (runner-agent 가 내려받는 산출물)

runner-agent 는 헬퍼 APK 를 `--helper-apk` → `SINCLAIR_AGENT_HELPER_APK` → 번들(`apps/runner-agent/resources/helper/`) → 리포 디버그 빌드 → `SINCLAIR_AGENT_HELPER_URL` 다운로드 순으로 찾는다. 다운로드는 sha256 사이드카가 있어야만 받는다(없으면 거부). 사내망 SSL 인터셉션에서는 `NODE_EXTRA_CA_CERTS` 를 그대로 따른다.

1. `versionName` 을 올리고(`app/build.gradle.kts`) `./gradlew assembleDebug` (또는 서명된 release 빌드).
2. 파일 이름과 체크섬:
   ```bash
   V=0.1.0   # versionName 과 같게
   cp app/build/outputs/apk/debug/app-debug.apk sinclair-helper-$V.apk
   shasum -a 256 sinclair-helper-$V.apk > sinclair-helper-$V.apk.sha256   # "<hex>  <파일명>" 한 줄
   ```
3. 두 파일을 릴리스 저장소(GitLab Release 또는 사내 아티팩트 서버)의 한 디렉터리에 올린다. 에이전트의 `SINCLAIR_AGENT_HELPER_URL` 은 그 디렉터리 URL 이다(파일명은 에이전트가 붙인다).
4. 에이전트의 고정 버전 `HELPER_APK_VERSION`(`apps/runner-agent/src/helper-apk.ts`)을 같은 값으로 올린다. 에이전트는 자기 버전의 파일만 찾는다.

캐시: `OS 데이터 디렉터리/sinclair/cache/helper/sinclair-helper-<V>.apk` + `.sha256`. 둘이 맞으면 네트워크 없이 쓴다.

## 설치·활성화·확인 (수동; 에이전트가 자동으로 한다)

```bash
ADB=$HOME/Library/Android/sdk/platform-tools/adb
$ADB install -r app/build/outputs/apk/debug/app-debug.apk

# 접근성 서비스 켜기. 반드시 --user 0: Secure Folder 가 있는 Samsung 에서는 기본 사용자가 150 으로 잡혀 설정이 다른 사용자에 쓰인다.
$ADB shell settings put --user 0 secure enabled_accessibility_services io.sinclair.helper/io.sinclair.helper.SinclairAccessibilityService
$ADB shell settings put --user 0 secure accessibility_enabled 1
$ADB shell dumpsys accessibility | grep "Bound services"      # Sinclair Helper 가 보여야 한다

$ADB forward tcp:38300 tcp:38300
curl -i http://127.0.0.1:38300/ping                            # 401 (토큰 없음)

TOKEN=$(openssl rand -hex 16)
$ADB shell am broadcast -a io.sinclair.helper.SET_TOKEN -n io.sinclair.helper/.TokenReceiver --es token $TOKEN
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:38300/ping
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:38300/dump | python3 -m json.tool
```

끄기: `settings put --user 0 secure enabled_accessibility_services ""`. 로그: `adb logcat -s SinclairHelper`.

## 주의

- `adb` 를 쓰면 adb server 가 USB 인터페이스를 점유한다. 디바이스 레이어의 직접 USB 경로(`SINCLAIR_TEST_USB`, `SINCLAIR_VERIFY_BACKEND=android`)를 쓰려면 `adb kill-server` 를 먼저 한다.
- 접근성 서비스는 기기가 재부팅돼도 설정이 유지되지만, 앱을 재설치하면 꺼진다(다시 `settings put`). 세션 토큰은 메모리에만 있어 서비스 재시작·재부팅 때 사라진다. 호스트(티켓 04)는 `/ping` 이 401 이면 토큰을 다시 보낸다.
- Android 13+ 에서 사이드로드 앱의 접근성 서비스는 설정 화면에서 "제한된 설정" 으로 막히지만 `settings put` 경로는 영향이 없다.
