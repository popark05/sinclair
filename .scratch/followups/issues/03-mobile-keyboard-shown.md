# 03: 모바일 엔진의 키보드 상태 — 실기기에서 키보드 Incident 복구를 켠다

**What to build:** 디바이스 레이어가 `dumpsys input_method` 로 화면 키보드 표시 여부를 주고(JSON-RPC), engine-mobile 이 `keyboard.shown()` 을 구현해 에이전트의 키보드 복구가 실기기에서도 동작한다. 실기기로 확인.

**Blocked by:** None

**Status:** ready-for-agent
