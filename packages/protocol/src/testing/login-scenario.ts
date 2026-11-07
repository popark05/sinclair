// FakeEngine 용 기준 화면: 로그인 화면. 계약 스위트와 러너 테스트가 같은 화면을 쓴다.
import type { SemanticNode } from '../engine.ts';
import { FakeEngine } from './fake-engine.ts';
import type { ContractScenario } from './engine-contract-suite.ts';

export const LOGIN_SCREEN: SemanticNode = {
  ref: '@e0', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
    { ref: '@e1', role: 'text', text: 'Sinclair 로그인', rect: { x: 0, y: 100, width: 1080, height: 80 } },
    { ref: '@e2', role: 'textbox', testId: 'com.app:id/username', placeholder: '아이디', rect: { x: 40, y: 300, width: 1000, height: 120 } },
    { ref: '@e3', role: 'textbox', testId: 'com.app:id/password', placeholder: '비밀번호', value: 'hunter2', states: { secure: true }, rect: { x: 40, y: 460, width: 1000, height: 120 } },
    { ref: '@e4', role: 'button', name: '로그인', rect: { x: 40, y: 640, width: 1000, height: 120 } },
    { ref: '@e5', role: 'button', name: '회원가입', states: { disabled: true }, rect: { x: 40, y: 800, width: 1000, height: 120 } },
  ],
};

export const HOME_SCREEN: SemanticNode = {
  ref: '@h0', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
    { ref: '@h1', role: 'text', text: '환영합니다', rect: { x: 0, y: 100, width: 1080, height: 80 } },
    { ref: '@h2', role: 'button', name: '로그아웃', rect: { x: 40, y: 640, width: 1000, height: 120 } },
  ],
};

export const LOGIN_SCENARIO: ContractScenario = {
  navButton: { role: 'button', name: '로그인' },
  afterNav: { text: '환영합니다' },
  textbox: { testId: 'username' },
  disabled: { role: 'button', name: '회원가입' },
  secure: { testId: 'password' },
  nonEditable: { role: 'text', text: 'Sinclair 로그인' },
};

/** 로그인 버튼을 탭하면 홈 화면으로 가는 FakeEngine. */
export function loginScenario(): FakeEngine {
  return new FakeEngine({
    root: LOGIN_SCREEN,
    onTap: (node) => (node.name === '로그인' ? HOME_SCREEN : undefined),
  });
}
