// 통과 1개. FakeEngine 로그인 시나리오용.
import { test } from '@sinclair/runner';

test('로그인 버튼을 누르면 환영 문구가 보인다', async ({ screen, expect }) => {
  await screen.getByRole('button', { name: '로그인' }).tap();
  await expect(screen.getByText('환영합니다')).toBeVisible();
});
