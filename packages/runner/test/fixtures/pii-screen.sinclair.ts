// 개인정보가 보이는 화면: 판정이 실패하면 오류 문구·마지막 관찰 요약·screen-tree 에 화면 글자가 실린다(가려져야 한다).
import { test } from '../../src/index.ts';

test('계정 행의 이메일이 다른 값이길 기대하다 실패한다', async ({ screen, expect, agent }) => {
  await agent.act('계정 행을 확인한다');
  await expect(screen.getByText(/계정/)).toHaveText('다른 계정');
});
