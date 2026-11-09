// 이름에 번호가 든 두 테스트: 식별 필드가 가려지면 control-plane 에서 하나로 합쳐진다(가리지 않아야 한다).
import { test } from '../../src/index.ts';

test('가입 010-1111-2222', async () => {});
test('가입 010-3333-4444', async () => {});
