// 비밀값 샘플: secret() 은 자리표시만 돌려주고, 러너가 입력하는 순간에만 실제 값으로 바꾼다.
import { test } from '../../src/index.ts';

test('비밀번호를 비밀값으로 넘겨 에이전트가 로그인한다', async ({ agent, secret, screen, expect }) => {
  await agent.act(`아이디 qa, 비밀번호 ${secret('QA_PASSWORD')} 로 로그인해줘`);
  await expect(screen.getByText('환영합니다')).toBeVisible();
});

test('screen 으로 비밀값을 입력한 뒤 판정이 실패한다(화면 요약·아티팩트에 값이 없어야 한다)', async ({ secret, screen, expect }) => {
  await screen.getByPlaceholder('비밀번호').type(secret('QA_PASSWORD'));
  await expect(screen.getByPlaceholder('비밀번호')).toHaveValue('다른 값'); // 실패 메시지의 '실제' 와 마지막 관찰에 입력값이 실린다
});

test('없는 비밀값을 쓰면 blocked', async ({ secret }) => {
  secret('NOT_CONFIGURED');
});
