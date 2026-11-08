// 재시도 검증용: 첫 시도만 실패한다(fixture attemptNo). retries 1 이면 passed-flaky 로 집계된다.
import { test } from '@sinclair/runner';

test('첫 시도에만 실패한다', async ({ screen, expect, attemptNo }) => {
  if (attemptNo === 1) await screen.getByText('없는 문구').tap();
  await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
});
