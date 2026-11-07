// 실패 1개. 종료 코드 1 검증용.
import { test } from '@sinclair/runner';

test('없는 문구를 찾다 실패한다', async ({ screen }) => {
  await screen.getByText('없는 문구').tap();
});
