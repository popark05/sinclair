// 재시도 정책 종단 증명용: 긴 테스트 몇 개. 데몬을 run 도중 죽이거나 heartbeat 를 끊을 시간을 만든다.
// 길이는 SINCLAIR_E2E_SLOW_MS(테스트 하나, 기본 2000ms), 개수는 SINCLAIR_E2E_SLOW_COUNT(기본 5). 데몬 프로세스의 환경변수로 준다.
import { test } from '@sinclair/runner';

const ms = Number(process.env.SINCLAIR_E2E_SLOW_MS ?? 2000);
const count = Number(process.env.SINCLAIR_E2E_SLOW_COUNT ?? 5);

for (let i = 1; i <= count; i++) {
  test(`재시도 > 긴 테스트 ${i}`, async ({ screen, expect }) => {
    await new Promise((r) => setTimeout(r, ms));
    await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible();
  });
}
