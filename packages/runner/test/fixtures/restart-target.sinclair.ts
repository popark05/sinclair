// app.restart(앱): 그 앱을 종료하고 다시 띄워 처음 화면에서 시작한다(Studio 가 내보낸 테스트의 첫 줄).
import { test } from '../../src/index.ts';

test('restart(앱) 은 그 앱의 처음 화면에서 시작한다', async ({ app, screen, expect }) => {
  await app.restart('com.android.settings');
  await expect(screen.getByText('설정', { exact: true })).toBeVisible();
});
