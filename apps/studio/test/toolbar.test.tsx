// @vitest-environment jsdom
// 툴바(studio 02): 연결 방식(데몬·직접·없음), 기기 선택(모델·끝 4자리·상태), 앱 id(현재 앱 채우기).
import './jsdom-polyfills.ts';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
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

  it('플랫폼이 다른 기기로 바꾸면 앱 id 를 비운다 — iPhone 의 번들 id 로 Android 세션·내보내기가 시작되지 않게', async () => {
    const apps: string[] = [];
    let selected = '';
    render(<Toolbar api={api({ listDevices: async () => [{ id: 'IPHONE0000002E', platform: 'ios', model: 'iPhone11,6', osVersion: '17.6.1', state: 'device' }, { id: 'R3CN30ABCDXLZW', platform: 'android', model: 'SM-N981N', osVersion: '13', state: 'device' }, { id: 'R3CN30ABCD0002', platform: 'android', model: 'SM-F936N', osVersion: '14', state: 'device' }] } as never)} onDeviceChange={(id) => { selected = id; }} onAppChange={(a) => { apps.push(a); }} />);
    await screen.findByText('데몬');
    expect(selected).toBe('IPHONE0000002E');
    const box = screen.getByRole('textbox', { name: '앱 id' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'com.apple.Preferences' } });
    const pick = async (label: RegExp): Promise<void> => {
      await act(async () => { fireEvent.click(screen.getByRole('combobox', { name: '기기' })); });
      await act(async () => { fireEvent.click(await screen.findByRole('option', { name: label })); });
    };
    await pick(/SM-N981N/);
    expect(selected).toBe('R3CN30ABCDXLZW');
    expect(box.value).toBe('');
    expect(apps.at(-1)).toBe('');
    expect(screen.getByRole('status', { name: '툴바 상태' }).textContent).toMatch(/앱 id 를 비움/);
    // 같은 플랫폼 기기끼리는 그대로
    fireEvent.change(box, { target: { value: 'com.android.settings' } });
    await pick(/SM-F936N/);
    expect(box.value).toBe('com.android.settings');
  });

  it('현재 앱을 알 수 없으면 버튼 옆에 사유, 새로 고침은 결과(기기 수)를 버튼 옆에 보인다', async () => {
    render(<Toolbar api={api({ foregroundApp: async () => null })} onDeviceChange={() => {}} onAppChange={() => {}} />);
    await screen.findByText('데몬'); // 기기 목록을 불러와 기기가 골라진 뒤
    const fg = await screen.findByRole('button', { name: '현재 앱' });
    await act(async () => { fg.click(); });
    const status = screen.getByRole('status', { name: '툴바 상태' });
    expect(status.textContent).toMatch(/앱을 알 수 없음/);
    await act(async () => { screen.getByRole('button', { name: '새로 고침' }).click(); });
    expect(status.textContent).toMatch(/기기 2대/);
  });

  it('설정(studio-console 03): control-plane 주소·테스트 폴더를 읽어 보여 주고 저장한다', async () => {
    const saved: unknown[] = [];
    render(<Toolbar api={api({ getSettings: async () => ({ controlPlane: 'http://127.0.0.1:4780', testsDir: '/Users/qa/Sinclair/tests' }), setSettings: async (s: unknown) => { saved.push(s); return s; } } as never)} onDeviceChange={() => {}} onAppChange={() => {}} />);
    await act(async () => { (await screen.findByRole('button', { name: '설정' })).click(); });
    const cp = await screen.findByRole('textbox', { name: 'control-plane 주소' }) as HTMLInputElement;
    expect(cp.value).toBe('http://127.0.0.1:4780');
    expect((screen.getByRole('textbox', { name: '테스트 폴더' }) as HTMLInputElement).value).toBe('/Users/qa/Sinclair/tests');
    fireEvent.change(cp, { target: { value: 'http://10.0.0.5:4780' } });
    await act(async () => { screen.getByRole('button', { name: '설정 저장' }).click(); });
    expect(saved).toEqual([{ controlPlane: 'http://10.0.0.5:4780', testsDir: '/Users/qa/Sinclair/tests' }]);
  });

  it('열기 요청(studio-console 06): selectRequest 로 그 기기를 고르고 앱 id 를 채운다', async () => {
    const picked: string[] = []; let app = '';
    const { rerender } = render(<Toolbar api={api()} onDeviceChange={(id) => picked.push(id)} onAppChange={(a) => { app = a; }} />);
    await screen.findByText('데몬');
    rerender(<Toolbar api={api({ listDevices: async () => [{ id: 'R3CN30ABCDXLZW', model: 'SM-N981N', osVersion: '13', state: 'device' }, { id: 'PIXEL0000007', model: 'Pixel 7', osVersion: '14', state: 'device' }] })} onDeviceChange={(id) => picked.push(id)} onAppChange={(a) => { app = a; }} selectRequest={{ deviceId: 'PIXEL0000007', app: 'com.example.app', nonce: 1 }} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(picked.at(-1)).toBe('PIXEL0000007');
    expect(app).toBe('com.example.app');
  });

  it('연결이 없으면 사유를 보인다', async () => {
    render(<Toolbar api={api({ connection: async () => ({ mode: 'none', detail: 'USB 를 열 수 없음' }), listDevices: async () => [] })} onDeviceChange={() => {}} onAppChange={() => {}} />);
    expect(await screen.findByText('연결 없음')).toBeTruthy(); // 불러온 뒤에 나타난다(툴바 자체는 먼저 그려진다)
    expect(await screen.findByText(/USB 를 열 수 없음/)).toBeTruthy();
  });
});
