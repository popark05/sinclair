// FakeEngine 이 엔진 계약 스위트를 통과한다. 러너 테스트의 기준 엔진이 계약을 어기면 여기서 걸린다.
import { engineContractSuite, loginScenario, LOGIN_SCENARIO } from '../src/testing/index.ts';

engineContractSuite('FakeEngine(로그인 화면)', { makeEngine: () => loginScenario(), scenario: LOGIN_SCENARIO });
