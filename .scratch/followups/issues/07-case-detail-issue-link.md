# 07: 케이스 상세 → Issue 링크

**What to build:** Console 케이스 상세의 실패 Attempt 에서 그 실패가 속한 Issue(서명) 로 가는 링크를 단다(followups 04 남긴 것).

**Blocked by:** None

**Status:** done

## 수용 기준

- [x] 실패(failed·blocked) Attempt 마다 `issueSignature` 와 같은 규칙으로 계산한 Issue id 로 `/console/issues#<id>` 링크. 서명 규칙은 한 곳(control-plane `issueSignature`)에만 둔다 — Console 은 서버가 준 id 를 쓴다.
- [x] Issue 목록에서 해당 Issue 가 강조된다.

## Comments

- 2026-11-10 구현. 서버 응답(GET /runs/:id)을 바꾸지 않고, 케이스 상세가 `GET /issues`(최근 20 Cycle)의 발생(runId·attemptId)으로 시도 → Issue id 를 찾는다 — 서명 규칙은 control-plane `issueSignature` 한 곳에만. Issue 목록을 못 불러오면 링크만 빠진다(화면은 그대로). 실패 시도 머리에 "같은 원인의 Issue" → `/console/issues#<id>`, Issue 행은 `id="issue-<id>"`·주소의 id 면 `issue-target` 강조 + `aria-current` + 가운데로 스크롤.
- 한계: 최근 20 Cycle 밖의 실패에는 링크가 없다(Issue 화면의 범위와 같다).
- 증명: verify-console 8/8(케이스 상세의 링크, 해시로 연 Issue 화면의 강조).
