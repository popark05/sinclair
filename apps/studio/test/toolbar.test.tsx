// @vitest-environment jsdom
// 툴바(studio 02): 연결 방식(데몬·직접·없음), 기기 선택(모델·끝 4자리·상태), 앱 id(현재 앱 채우기).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { Toolbar } from '../src/renderer/src/Toolbar.tsx';
import type { StudioApi } from '../src/shared/studio-ipc.ts';

afterEach(cleanup);
const api = (over: Partial<StudioApi> = {}): StudioApi => ({
  getWorkerStatus: async () => ({ state: 'ready' }), onWorkerStatus: () => () => {}, ping: async () => ({ roundTripMs: 1, node: 'v24' }),
  connection: async () => ({ mode: 'daemon', detail: '데몬 node-1 의 디바이스 RPC' }),
  listDevices: async () => [{ id: 'R3CN30ABCDXLZW', model: 'SM-N981N', osVersion: '13', state: 'device', helper: 'ready' }, { id: 'EMU0000001', model: 'sdk_gphone', osVersion: '14', state: 'unauthorized' }],
  foregroundApp: async () => 'com.google.android.youtube',
  ...over,
}) as unknown as StudioApi;

describe('Toolbar', () => {
  it('연결 방식과 첫 쓸 수 있는 기기를 고른 상태(원시 시리얼 대신 끝 4자리)', async () => {
    let selected = '';
    render(<Toolbar api={api()} onDeviceChange={(id) => { selected = id; }} onAppChange={() => {}} />);
    const nav = await screen.findByRole('navigation', { name: 'Studio 툴바' });
    await screen.findByText('데몬');
    expect(nav.textContent).toMatch(/SM-N981N.*…XLZW/);
    expect(nav.textContent).not.toContain('R3CN30ABCD');
    expect(selected).toBe('R3CN30ABCDXLZW');
  });

  it('현재 앱 버튼이 기기의 foreground 앱으로 앱 id 를 채운다', async () => {
    let app = '';
    render(<Toolbar api={api()} onDeviceChange={() => {}} onAppChange={(a) => { app = a; }} />);
    const btn = await screen.findByRole('button', { name: '현재 앱' });
    await act(async () => { btn.click(); });
    expect(app).toBe('com.google.android.youtube');
    expect((screen.getByRole('textbox', { name: '앱 id' }) as HTMLInputElement).value).toBe('com.google.android.youtube');
  });

  it('연결이 없으면 사유를 보인다', async () => {
    render(<Toolbar api={api({ connection: async () => ({ mode: 'none', detail: 'USB 를 열 수 없음' }), listDevices: async () => [] })} onDeviceChange={() => {}} onAppChange={() => {}} />);
    expect(await screen.findByText('연결 없음')).toBeTruthy(); // 불러온 뒤에 나타난다(툴바 자체는 먼저 그려진다)
    expect(await screen.findByText(/USB 를 열 수 없음/)).toBeTruthy();
  });
});
