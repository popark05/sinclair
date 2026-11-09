# 04: 플릿 상태 — 어떤 노드·기기가 쓸 수 있는지 본다

**What to build:** `/console/fleet` 이 노드(agentId, 마지막 보고)와 기기(상태 idle/leased/untrusted/offline, 모델·OS, 잠김, 헬퍼, 맡은 Run)를 표로 보여 주고 주기적으로 새로 고친다.

**Blocked by:** 01

**Status:** done

- [x] 노드·기기 표, 상태 배지, 사유(보고에서 빠짐 등)
- [x] leased 기기는 그 Run 으로 가는 링크
- [x] 테스트: 가짜 API 로 상태별 표시

## Comments

- 2026-11-09 구현(seam 승인): `pages/FleetPage.tsx` — 노드마다 온라인/끊김·마지막 보고, 기기 표(끝 4자리·모델·플랫폼 OS·연결·상태 배지 쓸 수 있음/사용 중/신뢰 안 됨/오프라인·사유·헬퍼·잠금), 사용 중 기기는 `/console/runs/:id` 링크 → `RunRedirect` 가 Run 의 Cycle 화면으로 넘김(Cycle 없는 로컬 Run 은 안내). 10초 새로 고침(이유 주석), 노드 없으면 안내. 머리띠에 Cycle·플릿 내비게이션.
