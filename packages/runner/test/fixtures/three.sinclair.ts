// 취소 검증용: 통과 3개. 두 번째 테스트 도중 abort 하면 [passed, passed, skipped] 가 돼야 한다.
import { test } from '../../src/index.ts';

test('첫째', async ({ screen, expect }) => { await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible(); });
test('둘째', async ({ screen, expect }) => { await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible(); });
test('셋째', async ({ screen, expect }) => { await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible(); });
