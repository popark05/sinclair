// Fleet 종단 실기기(device-fleet 06) 공용 샘플: 한 Cycle 의 suite 가 실기기(설정 앱 "설정")와 FakeEngine(로그인 화면 "Sinclair 로그인") 양쪽 열에서 돈다.
import { test } from '@sinclair/runner';

test('앱을 열면 첫 화면 제목이 보인다', async ({ app, screen, expect }) => {
  await app.open('com.android.settings');
  await expect(screen.getByText(/^(설정|Sinclair 로그인)$/)).toBeVisible();
});
