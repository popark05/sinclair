# 실기기: 설치본이 번들 APK 로 헬퍼를 설치한다

헬퍼가 없는 기기를 꽂고 설치본 에이전트를 돌리면 `resources/helper/` 의 번들 APK 로 설치·활성화·토큰까지 끝내고 테스트가 통과한다.

## Sub-features

- `device-uninstall` `adb uninstall io.sinclair.helper` 가 `Success`(증거에 기록).
- `device-bundled-apk` 로그 `헬퍼 APK: …/resources/helper/sinclair-helper-<V>.apk (bundled)`.
- `device-onboard` `헬퍼 설치됨` → (`접근성 활성화 재시도 n`) → `접근성 서비스 활성화됨` → `헬퍼 준비됨`.
- `device-pass` 설정 앱 샘플 passed, Cycle verified.

## How to get to it (user POV)

새 기기를 꽂고 `bin/sinclair-agent run --device <serial> --app com.android.settings --tests <dir> …`.

## Driving it with scripts

```bash
$S/run-device.sh $RUN [serial]      # DEVICE exit=0 finished/verified apk=bundled
```

## Gotchas

- 기기 잠금 해제, 한국어 UI(설정 앱 제목 "설정"), USB 디버깅 승인 필요. 처음 보는 호스트 키면 승인 대기 60초.
- 막 설치한 접근성 서비스는 첫 `settings put` 이 무시돼 재시도 로그가 1~2번 찍히는 것이 정상(CLAUDE.md 알려진 실수).
