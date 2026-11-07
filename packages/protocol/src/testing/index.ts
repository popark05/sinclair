// 주의: 이 인덱스는 vitest 계약 스위트를 함께 내보내므로 vitest 밖(제품 코드·스크립트)에서는 import 할 수 없다.
// FakeEngine·시나리오만 필요하면 '@sinclair/protocol/testing/fake-engine', '/testing/login-scenario' 를 쓴다.
export { FakeEngine, type FakeEngineOptions } from './fake-engine.ts';
export { engineContractSuite, type ContractScenario, type EngineContractOptions } from './engine-contract-suite.ts';
export { loginScenario, LOGIN_SCENARIO, LOGIN_SCREEN, HOME_SCREEN } from './login-scenario.ts';
