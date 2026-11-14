# 01: usbmux·lockdown 클라이언트(TS)

**What to build:** usbmuxd 유닉스 소켓(`/var/run/usbmuxd`, Windows 는 127.0.0.1:27015)의 plist 프로토콜: ListDevices, Listen(붙음·떨어짐 알림), Connect(기기 id·포트 → 그대로 터널이 되는 소켓). 터널 위 lockdownd(62078) 의 페어링 없는 GetValue(DeviceName·ProductType·ProductVersion). 호스트 TCP 포트 → 기기 포트 포워드(러너 HTTP 용). 가짜 usbmuxd·lockdownd 로 테스트.

**Status:** done

## 결과 (2026-11-15)

- `packages/device-layer/src/ios/plist.ts`(최소 XML plist), `usbmux.ts`(ListDevices·Listen·Connect 터널, `readLockdownValues` 페어링 없는 GetValue, `forwardPort` 연결마다 새 터널). 가짜 usbmuxd·lockdownd 테스트 5개.
- 실기: 이 Mac 의 usbmuxd 에서 iPhone(…002E, iPhone11,6 = XS Max, iOS 17.6.1) 목록·lockdown 값 읽기 확인.
