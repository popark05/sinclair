// 기기 화면 폴링(studio 03): 고른 기기의 스냅샷(스크린샷 + 트리)을 주기적으로 받는다. 겹쳐 묻지 않고, 조작 뒤에는 곧바로 다시 받는다.
// 같은 스냅샷을 Device 패널과 Inspector(04)가 함께 쓴다 — 화면과 트리가 늘 같은 순간이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioApi, StudioSnapshot } from '../../shared/studio-ipc.ts';

/** 초당 2장 남짓: 헬퍼의 원자 스냅샷 한 번이 수백 ms 라 그보다 자주 물어도 쌓이기만 한다 */
export const SNAPSHOT_INTERVAL_MS = 500;

export function useSnapshot(api: StudioApi, deviceId: string): { snapshot?: StudioSnapshot; error?: string; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<StudioSnapshot>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (!deviceId) return;
    if (inFlight.current) { again.current = true; return; } // 진행 중이면 끝난 뒤 한 번 더
    inFlight.current = true;
    try {
      const s = await api.snapshot(deviceId);
      if (alive.current) { setSnapshot(s); setError(undefined); }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      if (again.current && alive.current) { again.current = false; void fetchOnce(); }
    }
  }, [api, deviceId]);

  useEffect(() => {
    alive.current = true;
    setSnapshot(undefined);
    setError(undefined);
    if (!deviceId) return;
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), SNAPSHOT_INTERVAL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [deviceId, fetchOnce]);

  return { ...(snapshot ? { snapshot } : {}), ...(error ? { error } : {}), refresh: () => void fetchOnce() };
}
