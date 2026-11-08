// 재시도 정책 종단 증명용(verify-runner-agent retry-e2e): 첫 시도만 실패한다. suite.retries 1 이면 passed-flaky.
import { test } from '@sinclair/runner';

test('재시도 > 첫 시도만 실패한다', async ({ screen, expect, attemptNo }) => {
  if (attemptNo === 1) await screen.getByText('없는 문구').tap();
  await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
});
