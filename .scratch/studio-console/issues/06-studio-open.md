# 06: Studio 가 열기 요청을 받아 기기·목표를 채운다

**What to build:** 3초마다(설정의 control-plane) 연결된 기기들의 요청을 묻고, 오면 그 기기를 고르고 목표·앱을 채우고 "Console 에서 열림" 표시, ack. 자동 실행 없음. verify-studio·실기.

**Blocked by:** 05

**Status:** done

## 결과 (2026-11-14)

- 작업 프로세스 `fetchOpenRequests`·`ackOpenRequest`(설정의 control-plane), IPC `open-requests`(기기 id 20개까지)·`open-ack`. 렌더러 `useOpenRequests`: 3초마다 연결된(state device) 기기들의 요청 → 툴바가 그 기기를 고르고 앱 id 를 채움, 세션 패널이 목표를 채우고 "Console 에서 열림 · <테스트 · Cycle>" — 실행은 사람이. 처리하면 ack.
- verify-studio: fake 25/25, 실기 23/23(Console 과 같은 요청 → 목표 채움·ack). verify-console 케이스 상세에 "Studio 에서 열기" 버튼.
