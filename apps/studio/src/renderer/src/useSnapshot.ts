// 기기 화면 폴링(studio 03): 고른 기기의 스냅샷(스크린샷 + 트리)을 주기적으로 받는다. 겹쳐 묻지 않고, 조작 뒤에는 곧바로 다시 받는다.
// 같은 스냅샷을 Device 패널과 Inspector(04)가 함께 쓴다 — 화면과 트리가 늘 같은 순간이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenRequestView, StudioApi, StudioSnapshot } from '../../shared/studio-ipc.ts';

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

/** Run 이 기기를 쓰는 중일 때: 스냅샷(실기 약 2초)이 Run 의 화면 읽기와 기기 줄을 다투지 않게 드물게 */
export const SNAPSHOT_IN_USE_INTERVAL_MS = 10_000;
/** 기기가 Run 에 쓰이는지 묻는 간격(devices.list — 기기 줄을 쓰지 않는다). Run 이 시작되자마자 양보해야 재생(Run 앞부분)과 겹치지 않는다 — 5초였을 때 재생 act 13~15초 */
export const DEVICE_IN_USE_POLL_MS = 1_500;

/** 창 상태(와 Run 사용 여부) → 폴링 간격(undefined 면 멈춤) */
export const snapshotIntervalFor = (a: WindowActivity, inUse = false): number | undefined =>
  a === 'hidden' ? undefined : inUse ? SNAPSHOT_IN_USE_INTERVAL_MS : a === 'active' ? SNAPSHOT_INTERVAL_MS : SNAPSHOT_BACKGROUND_INTERVAL_MS;

/** 그 기기를 데몬의 Run 이 쓰는 중인가(기기 목록을 주기적으로 물어) */
export function useDeviceInUse(api: StudioApi, deviceId: string): boolean {
  const [inUse, setInUse] = useState(false);
  useEffect(() => {
    setInUse(false);
    if (!deviceId) return;
    let alive = true;
    const check = (): void => { void api.listDevices().then((list) => { if (alive) setInUse(!!list.find((d) => d.id === deviceId)?.inUse); }, () => {}); };
    check();
    const timer = setInterval(check, DEVICE_IN_USE_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [api, deviceId]);
  return inUse;
}

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

/** Console → Studio 열기 요청을 묻는 간격(control-plane 만 — 기기 줄을 쓰지 않는다) */
export const OPEN_REQUEST_POLL_MS = 3_000;

/** Console 이 남긴 열기 요청(studio-console 06): 연결된(state device) 기기들의 요청을 주기적으로 묻고, 오면 알리고 ack 한다 */
export function useOpenRequests(api: StudioApi, onRequest: (r: OpenRequestView) => void): void {
  const cb = useRef(onRequest);
  cb.current = onRequest;
  useEffect(() => {
    let alive = true;
    let busy = false;
    const check = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const devices = (await api.listDevices()).filter((d) => d.state === 'device').map((d) => d.id);
        if (!devices.length) return;
        for (const r of await api.openRequests(devices)) {
          if (!alive) return;
          cb.current(r);
          await api.openAck(r.id);
        }
      } catch { /* control-plane 이 없거나 설정 전: 다음 차례에 */ } finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => void check(), OPEN_REQUEST_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);
}
