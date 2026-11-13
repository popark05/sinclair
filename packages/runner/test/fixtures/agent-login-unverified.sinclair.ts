// 녹화 캐시: 검증 없이 끝나는 act(녹화를 확인할 수 없다)
import { test } from '../../src/index.ts';

test('검증 없는 로그인', async ({ agent }) => {
  await agent.act('아이디 qa 로 로그인해줘');
});
