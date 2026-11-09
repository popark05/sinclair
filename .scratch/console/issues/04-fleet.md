# 04: 플릿 상태 — 어떤 노드·기기가 쓸 수 있는지 본다

**What to build:** `/console/fleet` 이 노드(agentId, 마지막 보고)와 기기(상태 idle/leased/untrusted/offline, 모델·OS, 잠김, 헬퍼, 맡은 Run)를 표로 보여 주고 주기적으로 새로 고친다.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 노드·기기 표, 상태 배지, 사유(보고에서 빠짐 등)
- [ ] leased 기기는 그 Run 으로 가는 링크
- [ ] 테스트: 가짜 API 로 상태별 표시
