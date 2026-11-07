# 06: 접근성 제스처로 입력하고, 헬퍼가 없으면 shell로 떨어진다

**What to build:** `device.io.tap/longpress/swipe/text`가 헬퍼의 접근성 제스처 API를 1차 경로로 쓰고, 헬퍼가 꺼져 있거나 제스처가 거부되면 02의 `adb shell input` 경로로 자동 전환된다. 사용자 입장에서는 어느 경로든 같은 결과가 나오고, 어떤 경로를 탔는지 응답이나 로그로 알 수 있다.

**Blocked by:** 02 (shell 경로), 04 (헬퍼 연결)

**Status:** ready-for-agent

- [ ] 헬퍼에 tap/long_press/swipe/type 액션이 추가되고 `dispatchGesture` 결과(완료/취소)를 응답으로 돌려준다
- [ ] 백엔드가 헬퍼 상태에 따라 경로를 고르고, 헬퍼 경로 실패 시 같은 호출을 shell로 한 번 재시도한다
- [ ] 페이크 하네스로 세 경우(헬퍼 성공, 헬퍼 거부 후 shell 성공, 헬퍼 없음)를 검증하고 백엔드 호출 로그가 경로를 구분해 남긴다
- [ ] 텍스트 입력은 헬퍼 경로에서 IME 없이 포커스된 노드에 setText로 들어가고, 한글·이모지가 깨지지 않는다
- [ ] 실기기에서 서비스를 켠 상태와 끈 상태 각각 탭이 성공하는 증거가 남는다
- [ ] `features/device-io.md`, `features/serialization.md`가 두 경로를 반영한다
