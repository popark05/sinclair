// 앱 중간 비밀값(agent-secrets 02): act 가 blocked 로 멈추면 테스트는 blocked(비밀값 이름이 있으면 secret-missing, 없으면 agent-blocked).
// 결정적 코드는 screen.tapKeys(secret()) 로 키패드에 넣는다(에이전트 enter_secret 과 같은 규칙).
import { test } from '../../src/index.ts';

test('PIN 이 목표에 없으면 에이전트가 막힘을 알린다', async ({ agent }) => {
  await agent.act('차량 문을 연다');
});

test('사람만 할 단계면 막힘', async ({ agent }) => {
  await agent.act('본인인증까지 마친다');
});

test('키패드에 비밀값을 누른다', async ({ screen, secret, expect }) => {
  await screen.tapKeys(secret('SIMPLE_PIN'));
  await expect(screen.getByText('문 열림 전송 완료')).toBeVisible();
});
