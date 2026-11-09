// 실기기 에이전트 샘플(agent-layer 08): 설정 앱에서 목표를 이루고 판정, 비밀값 입력, 이룰 수 없는 목표의 실패.
import { test } from '../../src/index.ts';

test('에이전트가 설정에서 휴대전화 정보 화면을 연다', async ({ agent }) => {
  await agent.act('설정 앱에서 "휴대전화 정보" 화면을 연다');
  await agent.assert('휴대전화 정보 화면이 열려 있다');
});

test('비밀값을 설정 검색창에 입력한다', async ({ agent, secret }) => {
  await agent.act(`설정 검색을 열고 검색창에 ${secret('QA_SEARCH')} 를 입력한다`);
  await agent.assert('검색창에 검색어가 입력되어 있다');
});

test('이룰 수 없는 목표는 사유와 함께 실패한다', async ({ agent }) => {
  await agent.act('설정 앱에서 "우주선 조종" 메뉴를 열어 엔진을 켠다');
});
