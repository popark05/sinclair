// 기기 화면 폴링(studio 03): 고른 기기의 스냅샷(스크린샷 + 트리)을 주기적으로 받는다. 겹쳐 묻지 않고, 조작 뒤에는 곧바로 다시 받는다.
// 같은 스냅샷을 Device 패널과 Inspector(04)가 함께 쓴다 — 화면과 트리가 늘 같은 순간이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioApi, StudioSnapshot } from '../../shared/studio-ipc.ts';

/** 초당 2장 남짓: 헬퍼의 원자 스냅샷 한 번이 수백 ms 라 그보다 자주 물어도 쌓이기만 한다 */
export const SNAPSHOT_INTERVAL_MS = 500;
/** 창이 보이지만 포커스가 없을 때: 곁눈질용으로 느리게. 같은 기기의 데몬 실행(Run)이 Studio 스냅샷과 기기 줄을 다투지 않게 */
export const SNAPSHOT_BACKGROUND_INTERVAL_MS = 3_000;

/** 창 상태: active(포커스) · visible(보이지만 포커스 없음) · hidden(가려짐·최소화) */
export type WindowActivity = 'active' | 'visible' | 'hidden';
const readActivity = (): WindowActivity => (document.visibilityState === 'hidden' ? 'hidden' : document.hasFocus() ? 'active' : 'visible');

export function useWindowActivity(): WindowActivity {
  const [activity, setActivity] = useState<WindowActivity>(readActivity);
  useEffect(() => {
    const update = (): void => setActivity(readActivity());
    // blur 직후 hasFocus 는 아직 true 일 수 있어 이벤트 종류로 정한다
    const onBlur = (): void => setActivity(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
    window.addEventListener('focus', update);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', update); };
  }, []);
  return activity;
}

/** 창 상태 → 폴링 간격(undefined 면 멈춤) */
export const snapshotIntervalFor = (a: WindowActivity): number | undefined => (a === 'active' ? SNAPSHOT_INTERVAL_MS : a === 'visible' ? SNAPSHOT_BACKGROUND_INTERVAL_MS : undefined);

/**
 * paused: 주기 폴링을 멈춘다(refresh 는 된다). 에이전트 세션 중에는 기기를 세션에 양보한다 — 디바이스 RPC 는 기기마다 한 줄이라
 * 스냅샷(실기기 수 초)이 끼면 엔진의 dump 가 줄을 서 느려지고, 실기기에서 세션의 모든 탭이 "노드가 계속 움직인다" 로 거부됐다
 */
export function useSnapshot(api: StudioApi, deviceId: string, opts: { paused?: boolean; intervalMs?: number } = {}): { snapshot?: StudioSnapshot; error?: string; refresh: () => void } {
  const paused = !!opts.paused;
  const intervalMs = opts.intervalMs ?? SNAPSHOT_INTERVAL_MS;
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

  // 기기가 바뀌면 화면을 비운다
  useEffect(() => {
    alive.current = true;
    setSnapshot(undefined);
    setError(undefined);
    return () => { alive.current = false; };
  }, [deviceId]);
  useEffect(() => {
    if (!deviceId || paused) return;
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), intervalMs);
    return () => clearInterval(timer);
  }, [deviceId, fetchOnce, paused, intervalMs]);

  return { ...(snapshot ? { snapshot } : {}), ...(error ? { error } : {}), refresh: () => void fetchOnce() };
}
