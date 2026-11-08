// agent.act 1개. 실행기는 runner-agent 가 환경변수 설정(SINCLAIR_AGENT_*, ANTHROPIC_*)으로 만든다.
import { test } from '@sinclair/runner';

test('에이전트가 로그인하면 환영 문구가 보인다', async ({ agent, screen, expect }) => {
  await agent.act('로그인 버튼을 눌러 로그인해줘');
  await expect(screen.getByText('환영합니다')).toBeVisible();
});
