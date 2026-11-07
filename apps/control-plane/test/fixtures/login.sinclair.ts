// 통과하는 로그인 테스트 1개. Cycle 통합 테스트용.
import { test } from '@sinclair/runner';

test.describe('로그인', () => {
  test('아이디로 로그인한다', async ({ screen, expect }) => {
    await screen.getByRole('button', { name: '로그인' }).tap();
    await expect(screen.getByText('환영합니다')).toBeVisible();
  });
});
