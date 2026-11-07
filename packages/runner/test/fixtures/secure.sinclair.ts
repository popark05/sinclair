// secure 텍스트박스에 입력한 값이 리포트 어디에도 남지 않는지 검증한다.
import { test } from '../../src/index.ts';

test('비밀번호 입력값은 트레이스에 남지 않는다', async ({ screen }) => {
  await screen.getByTestId('password').type('hunter2');
});
