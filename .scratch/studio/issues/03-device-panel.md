# 03: Device 패널 — 스냅샷 폴링, 클릭·드래그·키 입력

**What to build:** 왼쪽 기기 패널이 `device.snapshot` 을 초당 2~5장 받아 그리고(작업 프로세스 푸시), 클릭은 탭, 드래그는 스와이프, 키보드는 입력·키, 뒤로·홈 버튼.

**Blocked by:** 02

**Status:** done

- [x] 좌표 변환(표시 크기 ↔ 기기 픽셀), 폴링 속도 조절(조작 직후 빠르게) — 화면 꺼짐·잠김 표시는 남김(아래)
- [x] 테스트: 좌표 변환, 페이크 백엔드로 탭·스와이프 호출 확인

## Comments

- 2026-11-14 구현. IPC 닫힌 요청에 snapshot·tap·swipe·text·key·button 추가(메인이 검사: 좌표 0~20000 정수로 반올림, 스와이프 50~5000ms, 글자 1~500자, 키는 enter·backspace·tab·escape·방향키만 — 작업 프로세스가 KEYCODE 로, 버튼 back·home). 작업 프로세스 `device-session` 이 `device.snapshot`(스크린샷 base64 + 같은 순간의 트리)·`device.io.*` 로.
- 렌더러: `useSnapshot`(고른 기기를 500ms 마다, 겹쳐 묻지 않고 조작 뒤 곧바로 다시) — Workspace 가 한 번 받아 Device 패널과 Inspector(04)가 같은 스냅샷을 본다. `DevicePanel`: `<img>`(object-fit contain — 라이브 화면은 astryx 컴포넌트가 없어 예외), 포인터 10px 미만 = 탭, 넘으면 스와이프(끈 시간 100~2000ms), 여백 클릭 무시, 화면에 초점을 두고 치면 글자는 300ms 모아 `text`, Enter·Backspace 등은 `key`, 뒤로·홈 버튼, 실패 사유 표시. 좌표는 `device-coords`(fitRect·toDevicePoint, 여백 계산).
- 실기: 데몬 경유로 SM-N981N 화면이 패널에 실시간으로 그려짐. 스냅샷 PNG 1080×2400 = 트리 화면 크기(헬퍼가 줄이지 않음) → 표시 좌표를 PNG 원본 크기로 바꾼 값이 곧 탭 좌표. 한 장 약 135KB. 실기기 탭은 보내지 않았다(화면이 통화 기록이라 잘못 누르면 전화가 걸림) — 입력 경로는 단위 테스트와 에이전트가 쓰는 같은 RPC 로 보증, 07 검증 스킬에서 안전한 앱 화면으로 확인.
- 남은 것: 화면 꺼짐·잠김 표시(스냅샷이 검은 화면일 때 데몬의 screenState 를 보여 주기), 롱프레스(길게 누르기) 입력, 화면이 바뀌지 않을 때 폴링 줄이기.
