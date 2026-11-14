# Studio ↔ Console 연결 (2026-11-14 결정)

- 범위: Studio → Console 먼저. 내보낸 테스트를 Studio 설정의 테스트 폴더(기본 ~/Sinclair/tests)에 저장하고 Cycle 로 등록 → 데몬이 돌림 → 결과·Console 링크. Console → Studio(실패 케이스에서 열기, URL 스킴)는 다음.
- 기기: Studio 에서 고른 그 기기에서 돈다 — 타깃 조건에 기기 시리얼(protocol TargetSelector.deviceId).
- control-plane 주소·테스트 폴더는 Studio 설정(메인 프로세스가 userData 에 저장).

## Console → Studio (2026-11-14 결정)

macOS 의 URL 스킴은 패키징된 앱(Info.plist)에서만 동작하고 Studio 는 패키징이 없다 → control-plane 중계. Console 케이스에서 "Studio 에서 열기" 가 control-plane 에 열기 요청(기기·목표·출처)을 남기고(메모리, 10분), 설정의 control-plane 을 아는 Studio 가 3초마다 그 기기의 요청을 확인해 기기를 고르고 목표를 채운다(자동 실행 없음) — 처리하면 ack.
