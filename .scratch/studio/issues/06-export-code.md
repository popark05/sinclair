# 06: 코드로 내보내기 — 자연어 또는 결정적 locator

**What to build:** 세션을 `*.sinclair.ts` 테스트 코드로 내보낸다. (a) 자연어: `agent.act` + `agent.assert`(녹화 캐시는 저장소에), (b) 결정적: 녹화한 액션을 locator 코드로 풀고 판정은 자연어 또는 `expect(...).toBeVisible()`. 클립보드·파일 저장.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 결정적 변환: 녹화 기술자 → `getByTestId`/`getByRole(name)`/`getByText` 우선순위, 비밀값은 `secret('이름')`
- [ ] 내보낸 코드가 FakeEngine 에서 그대로 통과하는지 테스트(왕복)
