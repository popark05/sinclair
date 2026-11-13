// 녹화 캐시: 같은 목표를 두 번(callIndex 0·1) — 둘째는 검증이 없다
import { test } from '../../src/index.ts';

test('로그인 두 번', async ({ agent, screen, expect, app }) => {
  await agent.act('아이디 qa 로 로그인해줘');
  await expect(screen.getByText('환영합니다')).toBeVisible();
  await app.restart();
  await agent.act('아이디 qa 로 로그인해줘');
});
