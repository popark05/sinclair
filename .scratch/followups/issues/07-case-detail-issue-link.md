# 07: 케이스 상세 → Issue 링크

**What to build:** Console 케이스 상세의 실패 Attempt 에서 그 실패가 속한 Issue(서명) 로 가는 링크를 단다(followups 04 남긴 것).

**Blocked by:** None

**Status:** ready-for-agent

## 수용 기준

- [ ] 실패(failed·blocked) Attempt 마다 `issueSignature` 와 같은 규칙으로 계산한 Issue id 로 `/console/issues#<id>` 링크. 서명 규칙은 한 곳(control-plane `issueSignature`)에만 둔다 — Console 은 서버가 준 id 를 쓴다.
- [ ] Issue 목록에서 해당 Issue 가 강조된다.

## Comments
