# 용어집

- **Cycle**: 한 번의 검증 주기. 빌드 + 기기 매트릭스 + Suite 필터.
- **Run**: Cycle 안에서 한 타깃에 대한 실행 1회.
- **Attempt**: Run 안의 테스트 1건 실행 시도. 재시도마다 새 Attempt.
- **Verdict**: Cycle 수준의 검증 현황 판단. 케이스(TestCase × 타깃)마다 `CaseVerdict`, Cycle 전체는 `CycleVerdict`(incomplete/verified/blocked).
- **TestCase**: 안정 ID 를 가진 테스트 1건. 지금은 러너 `test()` 의 이름(describe 경로를 " > " 로 이은 것)이 ID 다.
- **타깃(Target)**: Cycle 매트릭스의 열. 이름과 기기 선택 조건(플랫폼, 모델, OS 버전 범위)으로 정의되며, 조건에 맞는 아무 기기가 그 열을 채운다. Run 은 Cycle × 타깃이다. 이름만 있는 타깃(`android`)은 그 이름을 맡겠다고 선언한 노드가 채운다. _피할 말_: 기기(타깃을 특정 기기로 말할 때).
- **필수 태그(requiredTags)**: Cycle 이 `verified` 가 되려면 통과해야 하는 케이스를 고르는 태그. 테스트 이름의 `@태그` 토큰. 비면 모든 케이스가 필수.
- **fixture**: 테스트 전에 준비되고 끝나면 정리되는 리소스. `app`, `agent`, `screen`, `mock`.
- **녹화 캐시**: 에이전트 스텝의 액션을 의미 descriptor로 기록한 것. 재실행 시 모델 없이 재생.
- **이어받기(hand-off)**: 재생이 중간에 어긋나면 에이전트가 그 지점부터 계속하는 것.
- **엔진**: 러너와 플랫폼(웹/모바일) 사이의 계약(`Engine` SPI: observe/locate/perform) 구현체. 계약 스위트(`@sinclair/protocol/testing`)를 통과해야 한다.
- **locator**: 화면 요소를 가리키는 결정적 질의(`screen.getByRole` 등). 호출 시점에 재조회하며, strict 모드에서는 정확히 하나에 맞아야 한다.
- **판정(assertion)**: `expect(locator).toBeVisible()` 처럼 화면을 바꾸지 않고 상태를 기한 안에 확인하는 것. 에이전트의 `assert` 도 판정이다.
- **capability**: 엔진이 선택적으로 구현하는 능력(`pointer`, `keyboard`, `session`). 구현한 메서드로 결정된다.
- **디바이스 레이어**: 기기 조작 JSON-RPC 서버와 온디바이스 에이전트.

## Run 수명과 재시도 정책

- **Run lease**: 에이전트가 Run 을 클레임해 "지금 내가 돌리고 있다" 고 잡아 두는 시한부 권리. heartbeat 로 연장하고, 만료되면 다른 에이전트가 가져갈 수 있다. 기기 lease(Device)와는 다른 것이다.
- **재시도(retry)**: 같은 Run 안에서 실패한 테스트를 새 Attempt 로 다시 돌리는 것. Run 을 새로 만들지 않는다. _피할 말_: Run 재시도, 재실행(Run 단위로 쓸 때).
- **passed-flaky**: 재시도 끝에 통과한 케이스의 Verdict. 통과로 집계되지만 불안정함을 드러낸다.
- **버려진 Run(abandoned)**: 이벤트를 보내기 시작했는데 끝을 보고하지 않은 채 lease 가 만료되고 유예까지 지난 Run. 에이전트가 죽었다고 보고 `infra-failed` 로 닫는다. lease 없이 보고되는 Run 은 버려진 Run 이 되지 않는다.
- **대체 Run(replacement)**: 버려진 Run 의 몫을 같은 타깃에서 다시 돌리려고 control-plane 이 등록하는 새 Run. 대체된 Run 은 이력으로 남고 Verdict 에서 빠진다. _피할 말_: 재시도 Run, 재실행.
- **재시도 한도(retryLimit)**: Cycle 이 타깃마다 허용하는 대체 Run 의 수. 테스트 재시도 횟수와는 별개다. _피할 말_: 재시도 횟수(이 뜻으로 쓸 때).
- **취소(cancelled)**: lease 를 잃거나 종료 신호를 받아 Run 을 중간에 멈춘 것. 진행 중이던 테스트까지만 결과가 있고, 돌지 못한 케이스는 Verdict 에서 `blocked` 다. 대체 Run 을 자동으로 만들지 않는다.
- **blocked vs skipped**: `blocked` 는 돌아야 했는데 기기·취소 같은 인프라 사정으로 돌지 못한 케이스, `skipped` 는 테스트 쪽에서 돌지 않기로 한 케이스다.

## Fleet

- **노드(Node)**: 기기가 꽂혀 있고 데몬(runner-agent)이 도는 머신 하나. agentId 로 식별한다.
- **Fleet**: control-plane 이 노드들의 보고로 아는 기기 전체와 그 상태.
- **기기 상태(Device state)**: `idle`(Run 을 받을 수 있음), `leased`(Run 하나가 쓰는 중), `untrusted`(꽂혀 있지만 잠김·헬퍼 미준비·미승인이라 못 씀), `offline`(보고에서 빠짐).
- **기기 lease**: Run 하나가 기기 하나를 독점해 쓰는 시한부 권리. Run lease 와 수명이 묶여 함께 연장되고 함께 풀린다. _피할 말_: 기기 예약.
