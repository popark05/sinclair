# 03: 모바일 엔진의 키보드 상태 — 실기기에서 키보드 Incident 복구를 켠다

**What to build:** 디바이스 레이어가 `dumpsys input_method` 로 화면 키보드 표시 여부를 주고(JSON-RPC), engine-mobile 이 `keyboard.shown()` 을 구현해 에이전트의 키보드 복구가 실기기에서도 동작한다. 실기기로 확인.

**Blocked by:** None

**Status:** done

## Comments

- 2026-11-10 구현: protocol `device.io.keyboard`(결과 `{ shown: boolean | null }`, null = 모름 — 계약 테스트), 디바이스 레이어 백엔드 선택 `keyboardShown`(Android: `dumpsys input_method` 의 `mInputShown`, 줄이 없으면 undefined)과 서버 등록(백엔드가 모르면 null), engine-mobile `keyboard.shown()`(null 이면 false — dismiss 가 뒤로 버튼이라 근거 없이 누르지 않게). 이로써 agent-layer 06 의 키보드 Incident 복구가 실기기에서도 켜진다.
- 실기기 SM-N981N(Android 13): 설정 첫 화면 false → 검색창 탭 true → dismiss false. `packages/engine-mobile/test/keyboard.device.test.ts`(opt-in `SINCLAIR_TEST_USB`).
