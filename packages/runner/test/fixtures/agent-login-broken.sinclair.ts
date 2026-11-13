// 녹화 캐시 eviction: agent-login 과 같은 테스트 이름(같은 키)인데 act 뒤 검증이 실패한다
import { test } from '../../src/index.ts';

test('에이전트가 로그인한다', async ({ agent, screen, expect }) => {
  await agent.act('아이디 qa 로 로그인해줘');
  await expect(screen.getByText('없는 문구')).toBeVisible();
});
