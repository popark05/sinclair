// 취소 검증용: 통과 3개. 둘째 도중 취소하면 [passed, passed, skipped].
import { test } from '@sinclair/runner';

test('첫째', async ({ screen, expect }) => { await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible(); });
test('둘째', async ({ screen, expect }) => { await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible(); });
test('셋째', async ({ screen, expect }) => { await expect(screen.getByRole('button', { name: '로그인' })).toBeVisible(); });
