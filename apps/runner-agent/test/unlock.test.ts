// 잠긴 기기 풀기 정책: 한 번 시도, 보안 잠금이면 화면을 끄고 멈춤, 쓰는 중인 기기는 건드리지 않음, 풀리면 다시.
import { describe, it, expect } from 'vitest';
import { createUnlocker, type UnlockActions } from '../src/unlock.ts';

function fake(lockedAfter: boolean | undefined) {
  const calls: string[] = [];
  const actions: UnlockActions = {
    wake: async (id) => { calls.push(`wake ${id}`); },
    swipeUp: async (id) => { calls.push(`swipe ${id}`); },
    sleep: async (id) => { calls.push(`sleep ${id}`); },
    lockedNow: async (id) => { calls.push(`check ${id}`); return lockedAfter; },
  };
  return { actions, calls };
}

describe('createUnlocker', () => {
  it('비보안 잠금: 깨우고 스와이프해 풀리면 false 를 돌려주고 화면을 끄지 않는다', async () => {
    const f = fake(false); const logs: string[] = [];
    const u = createUnlocker(f.actions, { log: (l) => logs.push(l), settleMs: 0 });
    expect(await u.maybeUnlock('SER1', true, false)).toBe(false);
    expect(f.calls).toEqual(['wake SER1', 'swipe SER1', 'check SER1']);
    expect(logs).toEqual([]);
  });

  it('보안 잠금: 한 번 시도 뒤 화면을 끄고, 풀린 것을 볼 때까지 다시 깨우지 않는다(시간이 지나도)', async () => {
    const f = fake(true); const logs: string[] = []; let t = 0;
    const u = createUnlocker(f.actions, { log: (l) => logs.push(l), now: () => t, settleMs: 0 });
    expect(await u.maybeUnlock('SER1', true, false)).toBe(true);
    expect(f.calls).toEqual(['wake SER1', 'swipe SER1', 'check SER1', 'sleep SER1']);
    expect(logs).toEqual([expect.stringMatching(/…SER1 보안 잠금: 풀기 시도를 멈추고 화면을 끔/)]);
    t += 3_600_000;
    expect(await u.maybeUnlock('SER1', true, false)).toBe(true);
    expect(f.calls).toHaveLength(4); // 한 시간이 지나도 다시 깨우지 않는다
    // 사람이 풀었다: 다음에 또 잠기면 다시 한 번 시도한다
    expect(await u.maybeUnlock('SER1', false, false)).toBe(false);
    expect(logs[1]).toMatch(/잠금이 풀림/);
    await u.maybeUnlock('SER1', true, false);
    expect(f.calls).toHaveLength(8);
  });

  it('결과를 모르면(잠금 확인 실패) 간격 안에서는 다시 시도하지 않는다; 기기가 빠졌다 돌아오면 처음부터', async () => {
    const f = fake(undefined); let t = 0;
    const u = createUnlocker(f.actions, { log: () => {}, now: () => t, retryMs: 30_000, settleMs: 0 });
    expect(await u.maybeUnlock('SER1', true, false)).toBe(true); // 모르면 원래 값
    t += 29_999;
    await u.maybeUnlock('SER1', true, false);
    expect(f.calls).toHaveLength(3);
    t += 1;
    await u.maybeUnlock('SER1', true, false);
    expect(f.calls).toHaveLength(6);
    u.forget('SER1');
    await u.maybeUnlock('SER1', true, false);
    expect(f.calls).toHaveLength(9);
  });

  it('쓰는 중인 기기나 잠기지 않은 기기는 건드리지 않는다', async () => {
    const f = fake(false);
    const u = createUnlocker(f.actions, { log: () => {}, settleMs: 0 });
    expect(await u.maybeUnlock('SER1', true, true)).toBe(true);
    expect(await u.maybeUnlock('SER1', undefined, false)).toBeUndefined();
    expect(f.calls).toEqual([]);
  });
});
