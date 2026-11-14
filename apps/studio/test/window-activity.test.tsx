// @vitest-environment jsdom
// 창 상태(Studio 폴링 양보): 포커스면 active, 보이지만 포커스 없음 visible, 가려짐·최소화 hidden. 같은 기기의 데몬 실행이 Studio 스냅샷 폴링과
// 기기 줄을 다퉈 재생 act 가 7초 → 11~14초로 느려졌다(실기 2026-11-14) — 보지 않는 Studio 는 기기를 양보한다.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useWindowActivity, snapshotIntervalFor, SNAPSHOT_INTERVAL_MS, SNAPSHOT_BACKGROUND_INTERVAL_MS } from '../src/renderer/src/useSnapshot.ts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const setVisibility = (v: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });

describe('useWindowActivity', () => {
  it('focus·blur·visibilitychange 로 active → visible → hidden → active', async () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useWindowActivity());
    expect(result.current).toBe('active');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(result.current).toBe('visible');
    act(() => { setVisibility('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe('hidden');
    act(() => { setVisibility('visible'); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    expect(result.current).toBe('active');
  });

  it('폴링 간격: active 0.5초, visible 3초, hidden 멈춤', () => {
    expect(snapshotIntervalFor('active')).toBe(SNAPSHOT_INTERVAL_MS);
    expect(snapshotIntervalFor('visible')).toBe(SNAPSHOT_BACKGROUND_INTERVAL_MS);
    expect(SNAPSHOT_BACKGROUND_INTERVAL_MS).toBe(3_000);
    expect(snapshotIntervalFor('hidden')).toBeUndefined();
  });
});
