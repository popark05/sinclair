// @sinclair/protocol/testing 서브패스가 다른 패키지에서 import 되고 스위트가 돈다(티켓 01 완료 조건).
import { engineContractSuite, loginScenario, LOGIN_SCENARIO } from '@sinclair/protocol/testing';

engineContractSuite('runner 패키지에서 import 한 FakeEngine', { makeEngine: () => loginScenario(), scenario: LOGIN_SCENARIO });
