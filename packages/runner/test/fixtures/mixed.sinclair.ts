// 통과·실패·skip 이 섞인 파일. 실패 뒤 restart 와 아티팩트를 검증한다.
import { test } from '../../src/index.ts';

test('로그인 버튼이 보인다', async ({ screen, expect }) => {
  await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
});

test('없는 요소를 기다리다 실패한다', async ({ screen }) => {
  await screen.getByText('없는 문구').tap();
});

test.skip('아직 안 만든 기능', async () => {});

test('실패 뒤에도 다음 테스트는 처음 화면에서 시작한다', async ({ screen, expect }) => {
  await screen.getByRole('button', { name: '로그인' }).tap();
  await expect(screen.getByText('환영합니다')).toBeVisible();
});
