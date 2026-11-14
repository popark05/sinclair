# 03: iOS DeviceBackend

**What to build:** `createIosBackend`(platform ios): usbmux 기기 목록·lockdown 정보 → DeviceInfo, 러너 준비(주입한 실행기 — 기본 xcodebuild test-without-building — 를 띄우고 터널로 /ping 이 될 때까지), 화면·입력·앱을 러너로. 버튼(home·volume 등)·키 매핑. 가짜 usbmux + 가짜 러너로 device-layer 서버 계약 통과.

**Blocked by:** 01, 02

**Status:** ready-for-agent
