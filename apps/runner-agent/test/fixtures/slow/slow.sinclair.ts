// 워커·동시성 검증용(device-fleet 04): 긴 테스트 여럿. 길이는 SINCLAIR_E2E_SLOW_MS(기본 1500), 개수는 SINCLAIR_E2E_SLOW_COUNT(기본 2). 워커는 데몬의 환경변수를 물려받는다.
import { test } from '@sinclair/runner';

const ms = Number(process.env.SINCLAIR_E2E_SLOW_MS ?? 1500);
const count = Number(process.env.SINCLAIR_E2E_SLOW_COUNT ?? 2);
for (let i = 1; i <= count; i++) {
  test(`느린 테스트 ${i}`, async ({ screen, expect }) => {
    await new Promise((r) => setTimeout(r, ms));
    await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
  });
}
