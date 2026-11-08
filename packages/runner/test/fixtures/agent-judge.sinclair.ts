// 판정 동사 샘플: 결정적 탭 뒤 agent.waitFor·assert·extract 로 화면을 판정·추출한다. 둘째 테스트는 secure 칸을 추출하려 한다(거부돼야 한다).
import { test } from '../../src/index.ts';

test('판정 동사로 로그인 결과를 본다', async ({ agent, screen }) => {
  await screen.getByRole('button', { name: '로그인' }).tap();
  await agent.waitFor('환영 문구가 뜬다', { timeoutMs: 2000, intervalMs: 10 });
  await agent.assert('홈 화면이다');
  const greeting: string = await agent.extract('인사 문구', 'string');
  if (greeting !== '환영합니다') throw new Error(`extract 값이 다름: ${greeting}`);
});

test('비밀번호 칸을 추출하려 한다', async ({ agent }) => {
  await agent.extract('비밀번호', 'string');
});
