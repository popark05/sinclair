// agent.act 샘플: 자연어 목표 한 줄로 로그인하고, 결정적 판정(expect)으로 확인한다.
import { test } from '../../src/index.ts';

test('에이전트가 로그인한다', async ({ agent, screen, expect }) => {
  await agent.act('아이디 qa 로 로그인해줘');
  await expect(screen.getByText('환영합니다')).toBeVisible();
});
