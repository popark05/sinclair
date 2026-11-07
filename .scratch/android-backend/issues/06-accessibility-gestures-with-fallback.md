# 06: 접근성 제스처로 입력하고, 헬퍼가 없으면 shell로 떨어진다

**What to build:** `device.io.tap/longpress/swipe/text`가 헬퍼의 접근성 제스처 API를 1차 경로로 쓰고, 헬퍼가 꺼져 있거나 제스처가 거부되면 02의 `adb shell input` 경로로 자동 전환된다. 사용자 입장에서는 어느 경로든 같은 결과가 나오고, 어떤 경로를 탔는지 응답이나 로그로 알 수 있다.

**Blocked by:** 02 (shell 경로), 04 (헬퍼 연결)

**Status:** done

- [x] 헬퍼에 tap/long_press/swipe/type 액션이 추가되고 `dispatchGesture` 결과(완료/취소)를 응답으로 돌려준다
- [x] 백엔드가 헬퍼 상태에 따라 경로를 고르고, 헬퍼 경로 실패 시 같은 호출을 shell로 한 번 재시도한다
- [x] 페이크 하네스로 세 경우(헬퍼 성공, 헬퍼 거부 후 shell 성공, 헬퍼 없음)를 검증하고 백엔드 호출 로그가 경로를 구분해 남긴다
- [x] 텍스트 입력은 헬퍼 경로에서 IME 없이 포커스된 노드에 setText(기존 내용 뒤에 덧붙임)로 들어가고, 한글·이모지가 깨지지 않는다(페이크로 검증. 실기기 텍스트 입력은 입력 필드가 있는 앱이 필요해 미검증)
- [x] 실기기에서 헬퍼 경로(접근성 제스처)와 shell 경로(`preferShellInput`, 서비스를 끄면 자동 재활성화되므로 옵션으로 재현) 각각 탭이 앱을 열어 화면을 바꾸는 증거가 `.scratch/android-backend/evidence/06-input-route-latest.json` 에 남는다
- [x] `features/device-io.md`, `features/serialization.md`가 두 경로를 반영한다

## Comments

- 2026-11-07: 완료. 헬퍼 `POST /action`(tap/long_press/swipe 는 `dispatchGesture` 완료·취소를 200/409 로, type 은 포커스된 편집 노드에 `ACTION_SET_TEXT` 로 덧붙임), `canPerformGestures` 복원. 백엔드 `routedInput`: 헬퍼 ready 면 헬퍼, 거부(409)·호출 실패·미준비면 shell 로 한 번 재시도, `onInput` 이벤트와 `SINCLAIR_ADB_TRACE` 로 경로 노출, 진단용 `preferShellInput`. 페이크 테스트 6개(헬퍼 성공, 거부→shell, 없음→shell, 한글·이모지 setText, 포커스 없음→shell, 비ASCII+헬퍼 없음→-32602, preferShellInput). 실기기 SM-N981N: 두 경로 모두 런처 아이콘 탭으로 앱이 열림.
- 2026-11-07 리뷰 반영: (1) 두 경로 모두 실패하면 헬퍼 거부 이유가 사라지고 "헬퍼가 필요합니다" 류 메시지가 오해를 부르던 것 → 오류에 두 이유를 합치고 이벤트에 `failed` 기록(테스트 추가). (2) `fallbackReason` 문자열을 `fallback: {kind: refused|unavailable|preferred, detail}` 로 구조화해 테스트가 문구에 결합되지 않게. (3) `routedInput` 에 직렬화 전제(JSON-RPC 경유 시 디스패처, 직접 호출자는 스스로)와 헬퍼 timeout 뒤 shell 재시도 지연을 주석으로, `serialization.md` 에도. (4) Java 클래스를 artemis 와 같은 이름을 피해 `AccessibilityInput` 으로, JSON 본문 오류는 명시적 400(페이크도 동일), 죽은 기본값 제거, 비밀번호 필드는 덮어쓴다는 점과 API<33 recycle 미호출을 문서화. (5) 실기기 테스트 대기 상수 설명. 받아들인 한계: RPC 응답에는 경로가 없고 `onInput`/`SINCLAIR_ADB_TRACE` 로만 드러남(디버그 노이즈를 피하기 위한 결정); `preferShellInput` 은 "서비스가 꺼졌을 때 자동으로 shell 을 고른다" 의 실기기 증명이 아니라 shell 경로 자체의 증명(자동 선택 분기는 페이크로 검증); 실기기 텍스트 입력 미검증.
