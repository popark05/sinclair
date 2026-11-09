// @vitest-environment jsdom
// 플릿 화면: 노드(온라인·마지막 보고), 기기 표(끝 4자리·모델·OS·연결·상태 배지·사유·헬퍼·잠김), 사용 중 기기의 Run 링크, 10초 새로 고침, Run → Cycle 넘기기.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, act } from '@testing-library/react';
import type { FleetView } from '@sinclair/control-plane';
import { FleetPage, FLEET_REFRESH_MS } from '../src/pages/FleetPage.tsx';
import { App } from '../src/App.tsx';
import type { Api } from '../src/api.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); window.history.pushState({}, '', '/'); });
const fleet: FleetView = { nodeTtlMs: 60000, nodes: [
  { agentId: 'node-a', reportedAt: '2026-11-09T01:00:00.000Z', online: true, devices: [
    { id: 'R3CN30ABCDXLZW', platform: 'android', model: 'SM-N981N', osVersion: '13', connection: 'device', helper: 'ready', locked: false, state: 'leased', runId: 'r1' },
    { id: 'emulator-5554', platform: 'android', model: 'sdk_gphone', osVersion: '14', connection: 'device', helper: 'ready', locked: true, state: 'untrusted', reason: '화면 잠김' },
    { id: 'OLD123456789', platform: 'android', model: 'Pixel 7', osVersion: '14', connection: 'offline', state: 'offline', reason: '보고에서 빠짐' },
  ] },
  { agentId: 'node-b', reportedAt: '2026-11-09T00:50:00.000Z', online: false, devices: [] },
] };
const apiOf = (f: FleetView): Api & { calls: number } => {
  const api = { calls: 0, cycleSummaries: async () => [], cycle: async () => { throw new Error('x'); }, run: async () => ({ runId: 'r1', state: 'running' as const, cycleId: 'c9', attempts: [] }), fleet: async () => { api.calls++; return f; } };
  return api as Api & { calls: number };
};

describe('FleetPage', () => {
  it('노드와 기기: 끝 4자리·모델·OS·연결·상태 배지·사유·헬퍼·잠김, 사용 중이면 Run 링크', async () => {
    render(<FleetPage api={apiOf(fleet)} />);
    const a = await screen.findByRole('region', { name: '노드 node-a' });
    expect(a.textContent).toMatch(/node-a.*온라인/);
    const rows = within(a).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toMatch(/…XLZW.*SM-N981N.*Android 13.*device.*사용 중/);
    expect(rows[0]!.textContent).not.toContain('R3CN30ABCD');
    expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe('/console/runs/r1');
    expect(rows[1]!.textContent).toMatch(/신뢰 안 됨.*화면 잠김.*잠김/);
    expect(rows[2]!.textContent).toMatch(/오프라인.*보고에서 빠짐/);
    expect(screen.getByRole('region', { name: '노드 node-b' }).textContent).toMatch(/끊김.*보고한 기기 없음/);
  });

  it('10초마다 새로 고치고, 노드가 없으면 안내', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = apiOf(fleet);
    render(<FleetPage api={api} />);
    await screen.findByRole('region', { name: '노드 node-a' });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_REFRESH_MS); });
    expect(api.calls).toBe(2);
    expect(FLEET_REFRESH_MS).toBe(10000);
    cleanup();
    render(<FleetPage api={apiOf({ nodeTtlMs: 60000, nodes: [] })} />);
    expect(await screen.findByText(/보고한 노드가 없음/)).toBeTruthy();
  });

  it('/console/runs/:id 는 그 Run 의 Cycle 화면으로 넘기고, 머리띠에 Cycle·플릿 링크', async () => {
    window.history.pushState({}, '', '/console/runs/r1');
    const api = { ...apiOf(fleet), cycle: async () => ({ cycleId: 'c9', build: '9.9', targets: [], requiredTags: [], createdAt: '2026-11-09T01:00:00.000Z', state: 'finished' as const, verdict: 'verified' as const, runs: [], retryLimit: 1, retriesUsed: {}, required: [], matrix: {} }) };
    render(<App api={api} />);
    expect(await screen.findByRole('banner', { name: 'Cycle' })).toBeTruthy();
    expect(window.location.pathname).toBe('/console/cycles/c9');
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Cycle', '플릿']);
  });
});
