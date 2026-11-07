// 통과·실패·skip 이 섞인 샘플. 러너 → Ingest 통합 테스트용.
import { test } from '@sinclair/runner';

test('로그인 버튼이 보인다', async ({ screen, expect }) => {
  await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
});

test('없는 요소를 기다리다 실패한다', async ({ screen }) => {
  await screen.getByText('없는 문구').tap();
});

test.skip('아직 안 만든 기능', async () => {});
