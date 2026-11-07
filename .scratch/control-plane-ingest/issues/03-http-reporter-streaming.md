# 03: HTTP Reporter — 러너에서 Ingest 로 스트리밍

**What to build:** 러너에 Ingest 로 보내는 Reporter 가 생겨, `runTests` 에 Ingest 주소를 주면 테스트가 도는 동안 이벤트가 배치로 전송된다. 전송이 실패하면 같은 `eventId` 로 재시도하고(멱등 덕분에 안전), 서버가 잠시 꺼져 있어도 버퍼에 모았다가 다시 보낸다. run 이 끝날 때 flush 가 모두 전송될 때까지 기다린다. 인프로세스로 Ingest 서버를 띄운 통합 테스트가 "러너 → Reporter → Ingest → 조회" 가 러너 리포트와 같음을 증명한다.

**Blocked by:** 01 (Reporter 훅), 02 (Ingest)

**Status:** ready-for-agent

- [ ] HTTP Reporter: 배치 크기·간격·재시도 횟수·백오프 옵션, 상수마다 이유 주석
- [ ] 일시적 실패(5xx, 연결 거부)는 재시도, 검증 거부(4xx `rejected`)는 재시도하지 않고 경고로 남긴다
- [ ] 재시도로 같은 이벤트가 두 번 가도 Ingest 투영이 변하지 않는 테스트(서버가 첫 응답을 일부러 끊음)
- [ ] 서버가 run 중간에 내려갔다 올라와도 flush 뒤 모든 이벤트가 저장된다
- [ ] flush 가 기한 안에 못 끝나면 러너는 경고와 함께 리포트를 돌려주고 멈추지 않는다
- [ ] 통합 테스트: FakeEngine 샘플 run → HTTP Reporter → 인프로세스 Ingest → `GET /runs/:id` 가 `RunReport` 와 일치
- [ ] `verify-ingest` 스킬에 "러너에서 흘려보내기" feature 추가
