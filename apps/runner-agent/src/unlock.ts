// 잠긴 기기 풀기 정책: 클레임 후보를 고를 때 잠긴 기기를 한 번 깨우고 위로 스와이프해 본다(비보안 잠금은 이것으로 풀린다).
// 풀리지 않으면 보안 잠금(PIN·패턴)으로 보고 화면을 다시 끄고, 풀린 것이 보이거나 기기가 빠졌다 다시 꽂힐 때까지 다시 깨우지 않는다.
// 잠긴 폰을 30초마다 깨우면 화면이 거의 계속 켜져(배터리·번인·주인의 불편) — 한 번만 시도하는 이유다.

export interface UnlockActions {
  /** 화면을 켜고 잠금화면을 앞으로(WAKEUP·MENU) */
  wake(id: string): Promise<void>;
  /** 화면 아래에서 위로 스와이프(화면 크기에 맞춰) */
  swipeUp(id: string): Promise<void>;
  /** 화면을 끈다(보안 잠금이라 못 풀었을 때 켜 둔 화면을 되돌린다) */
  sleep(id: string): Promise<void>;
  /** 지금 잠겨 있는지. 모르면 undefined */
  lockedNow(id: string): Promise<boolean | undefined>;
}

export interface Unlocker {
  /** 잠긴 기기면(쓰는 중이 아니고, 보안 잠금으로 판정되지 않았고, 최근에 시도하지 않았으면) 한 번 풀어 보고 그 뒤의 잠금 상태를 돌려준다 */
  maybeUnlock(id: string, locked: boolean | undefined, inUse: boolean): Promise<boolean | undefined>;
  /** 기기가 목록에서 빠졌다: 다시 꽂히면 처음부터 */
  forget(id: string): void;
}

/** 같은 기기를 다시 시도하는 최소 간격(풀기 결과를 모를 때만 의미가 있다; 보안 잠금은 아예 다시 시도하지 않는다) */
export const UNLOCK_RETRY_MS = 30_000;

export function createUnlocker(actions: UnlockActions, opts: { log: (line: string) => void; now?: () => number; retryMs?: number; settleMs?: number }): Unlocker {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? UNLOCK_RETRY_MS;
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, opts.settleMs ?? 500));
  const lastTry = new Map<string, number>();
  const secure = new Set<string>();
  return {
    async maybeUnlock(id, locked, inUse) {
      if (locked === false) {
        if (secure.delete(id)) opts.log(`기기 …${id.slice(-4)} 잠금이 풀림: 다시 후보로 볼 수 있음`);
        return locked;
      }
      if (!locked || inUse || secure.has(id) || now() - (lastTry.get(id) ?? -Infinity) < retryMs) return locked;
      lastTry.set(id, now());
      await actions.wake(id).catch(() => undefined);
      await actions.swipeUp(id).catch(() => undefined);
      await settle();
      const after = await actions.lockedNow(id).catch(() => undefined);
      if (after === true) {
        secure.add(id);
        await actions.sleep(id).catch(() => undefined);
        opts.log(`기기 …${id.slice(-4)} 보안 잠금: 풀기 시도를 멈추고 화면을 끔(사람이 풀면 다시 후보로)`);
      }
      return after ?? locked;
    },
    forget(id) {
      lastTry.delete(id);
      secure.delete(id);
    },
  };
}
