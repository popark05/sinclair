// 샘플 테스트: 설정 앱을 열고 제목이 보이는지. FakeEngine(시뮬레이션 트리)과 실기기 양쪽에서 돈다.
import { test } from '../../src/index.ts';

test.describe('설정 앱', () => {
  test('열면 "설정" 제목이 보인다', async ({ app, screen, expect }) => {
    await app.open('com.android.settings');
    await expect(screen.getByText('설정', { exact: true })).toBeVisible();
  });
});
