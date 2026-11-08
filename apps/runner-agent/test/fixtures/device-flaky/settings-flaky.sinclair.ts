// 실기기 재시도 샘플: 첫 시도만 설정 앱에 없는 문구를 기다려 실패하고, 재시도에 "설정" 제목을 확인한다(fixture attemptNo).
import { test } from '@sinclair/runner';

test('설정 앱 — 첫 시도만 실패, 재시도에 "설정" 제목', async ({ app, screen, expect, attemptNo }) => {
  await app.open('com.android.settings');
  if (attemptNo === 1) await expect(screen.getByText('이런 문구는 설정에 없다')).toBeVisible();
  await expect(screen.getByText('설정', { exact: true })).toBeVisible();
});
