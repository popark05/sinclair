// engine-mobile 이 엔진 계약 스위트를 통과한다(가짜 기기 서버 위에서).
import { engineContractSuite, LOGIN_SCENARIO } from '@sinclair/protocol/testing';
import { createDeviceServer } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '../src/index.ts';
import { ScenarioBackend } from './scenario-backend.ts';

engineContractSuite('engine-mobile(ScenarioBackend)', {
  makeEngine: () => createMobileEngine(rpcOverDispatcher(createDeviceServer([new ScenarioBackend()])), { deviceId: 'PHONE1', appId: 'com.example.app', settleChangeMs: 50 }), // 계약 스위트는 안 바뀌는 화면에 모든 액션을 해 본다: 변화 대기를 짧게
  scenario: LOGIN_SCENARIO,
  navTimeoutMs: 2_000,
});
