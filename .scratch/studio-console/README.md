# Studio ↔ Console 연결 (2026-11-14 결정)

- 범위: Studio → Console 먼저. 내보낸 테스트를 Studio 설정의 테스트 폴더(기본 ~/Sinclair/tests)에 저장하고 Cycle 로 등록 → 데몬이 돌림 → 결과·Console 링크. Console → Studio(실패 케이스에서 열기, URL 스킴)는 다음.
- 기기: Studio 에서 고른 그 기기에서 돈다 — 타깃 조건에 기기 시리얼(protocol TargetSelector.deviceId).
- control-plane 주소·테스트 폴더는 Studio 설정(메인 프로세스가 userData 에 저장).
