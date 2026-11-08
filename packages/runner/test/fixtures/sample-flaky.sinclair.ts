// 재시도 실기기 샘플: 첫 시도만 설정 앱에 없는 문구를 기다려 실패하고, 두 번째 시도에 "설정" 제목을 확인한다(fixture attemptNo).
import { test } from '../../src/index.ts';

test.describe('설정 앱 (재시도)', () => {
  test('첫 시도는 없는 문구로 실패, 재시도에 "설정" 제목이 보인다', async ({ app, screen, expect, attemptNo }) => {
    await app.open('com.android.settings');
    if (attemptNo === 1) await expect(screen.getByText('이런 문구는 설정에 없다 ' + Date.now())).toBeVisible();
    await expect(screen.getByText('설정', { exact: true })).toBeVisible();
  });
});
