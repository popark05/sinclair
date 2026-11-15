// @vitest-environment jsdom
// 기기 화면 폴링(studio 03): 주기적으로 받고, 세션 중에는 멈춘다(에이전트가 기기를 쓰는 동안 줄을 서지 않게 — 실기기에서 dump 가 느려져 모든 탭이 거부됐다)
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSnapshot, SNAPSHOT_INTERVAL_MS } from '../src/renderer/src/useSnapshot.ts';
import type { StudioApi } from '../src/shared/studio-ipc.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const api = () => { const calls = { n: 0 }; return { calls, api: { snapshot: async () => { calls.n++; return { png: '', root: { ref: '@e0', role: 'root' } }; } } as unknown as StudioApi }; };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useSnapshot', () => {
  it('주기적으로 받는다', async () => {
    vi.useFakeTimers();
    const { calls, api: a } = api();
    renderHook(() => useSnapshot(a, 'SER1'));
    await tick(SNAPSHOT_INTERVAL_MS * 4 + 10);
    expect(calls.n).toBeGreaterThanOrEqual(4);
  });

  it('paused 면 주기 폴링을 멈추고, refresh 는 한 번 받는다; 풀리면 다시 폴링', async () => {
    vi.useFakeTimers();
    const { calls, api: a } = api();
    const { result, rerender } = renderHook(({ paused }) => useSnapshot(a, 'SER1', { paused }), { initialProps: { paused: true } });
    await tick(SNAPSHOT_INTERVAL_MS * 6);
    expect(calls.n).toBe(0);
    await act(async () => { result.current.refresh(); });
    await tick(10);
    expect(calls.n).toBe(1);
    rerender({ paused: false });
    await tick(SNAPSHOT_INTERVAL_MS * 3 + 10);
    expect(calls.n).toBeGreaterThanOrEqual(3);
  });

  it('intervalMs 로 간격을 바꾼다(보이지만 포커스 없는 창은 3초)', async () => {
    vi.useFakeTimers();
    const { calls, api: a } = api();
    renderHook(() => useSnapshot(a, 'SER1', { intervalMs: 3_000 }));
    await tick(3_000 * 2 + 10);
    expect(calls.n).toBe(3); // 처음 1 + 3초마다 2
  });
});

describe('useSnapshot · 기기 바꾸기', () => {
  it('바꾸기 전 기기의 스냅샷이 늦게 와도 새 기기 화면으로 쓰지 않는다 — 실기에서 iPhone 으로 바꾼 뒤 Android 화면이 iPhone 라벨로 보였다', async () => {
    const pending = new Map<string, (s: unknown) => void>();
    const api = { snapshot: (id: string) => new Promise((resolve) => { pending.set(id, resolve); }) } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ id }) => useSnapshot(api, id), { initialProps: { id: 'ANDROID' } });
    await act(async () => {});
    expect(pending.has('ANDROID')).toBe(true);
    rerender({ id: 'IPHONE' });
    await act(async () => { pending.get('ANDROID')!({ png: 'android', root: { ref: '@e0', role: 'root' }, width: 1080, height: 2400 }); });
    expect(result.current.snapshot).toBeUndefined();
    // 새 기기의 요청은 이전 요청이 끝난 뒤에라도 나간다
    await act(async () => {});
    expect(pending.has('IPHONE')).toBe(true);
    await act(async () => { pending.get('IPHONE')!({ png: 'iphone', root: { ref: '@e0', role: 'root' }, width: 1242, height: 2688 }); });
    expect(result.current.snapshot).toMatchObject({ png: 'iphone' });
  });
});
