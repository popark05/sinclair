# 03: runner `screen` locator

**What to build:** 테스트 작성자가 `screen.getByRole('button', { name: '로그인' })` 처럼 화면 요소를 가리키고 `tap()/type()` 할 수 있다. 정확히 하나가 아니면 실패(strict), 아직 없으면 기한까지 기다린다. 비밀번호 같은 `secure` 요소의 내용은 테스트 코드도 읽을 수 없다.

**Blocked by:** 01 (FakeEngine)

**Status:** done

- [x] `screen.getByRole/getByText/getByTestId/getByPlaceholder/getByLabel` 과 체이닝 `.within(locator)`, `.nth(i)`, `.first()`. locator 는 lazy 이며 호출 시점에 재조회한다
- [x] 액션 `tap/longPress/type/press/select/check/scrollIntoView` 가 기한(기본 10초, 테스트 옵션으로 변경) 안에 자동 대기·재조회한다. 후보가 0개면 기한까지 기다린 뒤 `not-found`, 2개 이상이면 **대기 없이** `ambiguous`(후보 요약 포함, 결정은 spec 0002), 비활성이면 기한까지 기다린 뒤 `not-actionable`
- [x] `secure` 노드의 `text/value` 를 읽으려 하면 `secure-read` 로 거부하고, `type` 은 허용한다. 값이 로그·트레이스에 남지 않는 것은 러너 트레이스가 생기는 티켓 05 에서 검증(지금 러너에는 로그가 없음)
- [x] 실패 메시지에 질의, 기다린 시간, 마지막 관찰의 관련 노드 요약(최대 5개)이 들어간다
- [x] specs/0001 의 "bounds 기반 체이닝 fallback": 지금 추가하기로 결정. `locateInTree` 의 `within` 이 트리 자손에서 못 찾으면 scope 의 rect 안에 완전히 놓인 노드로 다시 찾는다(계약 테스트 2개, spec 0002 갱신)
- [x] FakeEngine 으로 위 규칙과 "나중에 나타나는 요소를 기다려 탭" 시나리오가 검증된다

## Comments

- 2026-11-07: 완료. `createScreen(engine, { timeoutMs, pollMs })` → `getByRole/Text/TestId/Placeholder/Label`(+`exact`), `.within/.nth/.first`, `count/isVisible/text/value/resolve/describe`, 액션 `tap/longPress/type/press/select/check/scrollIntoView`. strict: 2개 이상이면 즉시 `ambiguous`(후보 최대 5개 요약), 0개면 기한까지 재조회 뒤 `not-found`(기다린 ms), 비활성이면 기한까지 활성화 대기 뒤 `not-actionable`. secure 노드는 `text/value` 읽기만 `secure-read`, `type` 허용. FakeEngine 테스트 11개(lazy·재조회는 `locateCalls` 로, 나중에 나타나는 요소·활성화는 `setRoot` 로). bounds 체이닝 fallback 은 protocol 에 추가.
- 2026-11-07 리뷰 반영: (1) not-found 메시지에 마지막 화면의 관련 노드(같은 role, 최대 5개) 요약 추가. (2) `check`/`select` 를 실제로 구동하는 테스트(로그인 화면 픽스처에 checkbox·combobox 추가), 테스트 제목이 커버리지를 과장하지 않게 수정. (3) `within` 의 부모 해석이 자식과 같은 기한을 쓰도록(깊이만큼 늘지 않음, 테스트). (4) 공개 Locator 에 숨겨 두던 spec 을 WeakMap 으로, 다른 screen 의 locator 를 넘기면 오류. (5) `isVisible` 은 "정확히 하나" 만 뜻하고 활성 여부는 보지 않음(04 의 toBeDisabled 와 분리). (6) bounds fallback 이 scope 의 조상을 제외하도록(같은 rect 의 부모 컨테이너 테스트), 조건·nth·0크기·다른 레이어 한계를 spec 에 명시. (7) spec 0002 에 러너 locator 정책 절(ambiguous 즉시, getByLabel = name, secure 트레이스는 05, within 기한). 테스트 대기 상수 설명. 범위 밖이던 `count/isVisible/text/value/resolve/describe` 는 04(expect) 가 쓰는 선행 구현.
