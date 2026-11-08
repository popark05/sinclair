// 재시도 검증용: 첫 시도만 실패하는 테스트, 끝내 실패하는 테스트, 시도 번호를 쓰지 않는 통과 테스트.
import { test } from '../../src/index.ts';

test('첫 시도에만 없는 문구를 찾는다', async ({ screen, expect, attemptNo }) => {
  if (attemptNo === 1) await screen.getByText('없는 문구').tap();
  await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
});

test('끝내 실패한다', async ({ screen }) => {
  await screen.getByText('없는 문구').tap();
});

test('로그인 버튼이 보인다', async ({ screen, expect }) => {
  await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
});
