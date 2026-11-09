// FakeEngine 이 엔진 계약 스위트를 통과한다. 러너 테스트의 기준 엔진이 계약을 어기면 여기서 걸린다.
import { engineContractSuite, loginScenario, LOGIN_SCENARIO } from '../src/testing/index.ts';

engineContractSuite('FakeEngine(로그인 화면)', { makeEngine: () => loginScenario(), scenario: LOGIN_SCENARIO });

import { describe, it, expect } from 'vitest';
describe('FakeEngine 키보드 상태', () => {
  it('입력 칸에 type 하면 키보드가 뜨고(shown true), dismiss 하면 내려간다', async () => {
    const e = loginScenario();
    expect(await e.keyboard.shown()).toBe(false);
    await e.perform('@e2', 'type', 'qa');
    expect(await e.keyboard.shown()).toBe(true);
    await e.keyboard.dismiss();
    expect(await e.keyboard.shown()).toBe(false);
  });
});
