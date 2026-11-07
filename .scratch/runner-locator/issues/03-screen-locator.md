# 03: runner `screen` locator

**What to build:** 테스트 작성자가 `screen.getByRole('button', { name: '로그인' })` 처럼 화면 요소를 가리키고 `tap()/type()` 할 수 있다. 정확히 하나가 아니면 실패(strict), 아직 없으면 기한까지 기다린다. 비밀번호 같은 `secure` 요소의 내용은 테스트 코드도 읽을 수 없다.

**Blocked by:** 01 (FakeEngine)

**Status:** ready-for-agent

- [ ] `screen.getByRole/getByText/getByTestId/getByPlaceholder/getByLabel` 과 체이닝 `.within(locator)`, `.nth(i)`, `.first()`. locator 는 lazy 이며 호출 시점에 재조회한다
- [ ] 액션 `tap/longPress/type/press/select/check/scrollIntoView` 가 기한(기본 10초, 테스트 옵션으로 변경) 안에 자동 대기·재조회한다. 후보가 0개면 `not-found`, 2개 이상이면 `ambiguous`(후보 요약 포함), 비활성이면 기한까지 기다린 뒤 `not-actionable`
- [ ] `secure` 노드의 `text/value` 를 읽으려 하면 `secure-read` 로 거부하고, `type` 은 허용한다(값은 로그·트레이스에 남지 않음)
- [ ] 실패 메시지에 질의, 기다린 시간, 마지막 관찰의 관련 노드 요약(최대 5개)이 들어간다
- [ ] FakeEngine 으로 위 규칙과 "나중에 나타나는 요소를 기다려 탭" 시나리오가 검증된다
