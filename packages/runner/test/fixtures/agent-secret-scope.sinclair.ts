// 비밀값 범위: 첫 테스트가 등록한 비밀값을 둘째 테스트가 secret() 없이 자리표시로 입력하려 한다(치환되면 안 된다).
import { test } from '../../src/index.ts';

test('비밀값을 등록하고 입력한다', async ({ secret, screen }) => {
  await screen.getByPlaceholder('비밀번호').type(secret('QA_PASSWORD'));
});

test('등록하지 않은 비밀값 자리표시를 입력하려 한다', async ({ screen }) => {
  await screen.getByPlaceholder('아이디').type('{{secret:QA_PASSWORD}}');
});
