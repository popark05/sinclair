# 용어집

- **Cycle**: 한 번의 검증 주기. 빌드 + 기기 매트릭스 + Suite 필터.
- **Run**: Cycle 안에서 한 타깃에 대한 실행 1회.
- **Attempt**: Run 안의 테스트 1건 실행 시도. 재시도마다 새 Attempt.
- **Verdict**: Cycle 수준의 검증 현황 판단.
- **fixture**: 테스트 전에 준비되고 끝나면 정리되는 리소스. `app`, `agent`, `screen`, `mock`.
- **녹화 캐시**: 에이전트 스텝의 액션을 의미 descriptor로 기록한 것. 재실행 시 모델 없이 재생.
- **이어받기(hand-off)**: 재생이 중간에 어긋나면 에이전트가 그 지점부터 계속하는 것.
- **엔진**: 러너와 플랫폼(웹/모바일) 사이의 계약(`Engine` SPI: observe/locate/perform) 구현체. 계약 스위트(`@sinclair/protocol/testing`)를 통과해야 한다.
- **locator**: 화면 요소를 가리키는 결정적 질의(`screen.getByRole` 등). 호출 시점에 재조회하며, strict 모드에서는 정확히 하나에 맞아야 한다.
- **판정(assertion)**: `expect(locator).toBeVisible()` 처럼 화면을 바꾸지 않고 상태를 기한 안에 확인하는 것. 에이전트의 `assert` 도 판정이다.
- **capability**: 엔진이 선택적으로 구현하는 능력(`pointer`, `keyboard`, `session`). 구현한 메서드로 결정된다.
- **디바이스 레이어**: 기기 조작 JSON-RPC 서버와 온디바이스 에이전트.
