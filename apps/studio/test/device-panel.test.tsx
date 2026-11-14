// @vitest-environment jsdom
// Device 패널(studio 03): 스냅샷을 그리고, 클릭 = 탭(기기 픽셀), 드래그 = 스와이프, 키보드 = 글자·키, 뒤로·홈.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DevicePanel } from '../src/renderer/src/DevicePanel.tsx';
import type { StudioApi, StudioSnapshot } from '../src/shared/studio-ipc.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });
// jsdom 의 PointerEvent 는 clientX 를 싣지 않는다: 마우스 이벤트 바탕으로 채운다(테스트 환경 한정)
class TestPointerEvent extends MouseEvent { constructor(type: string, init?: PointerEventInit) { super(type, init); } }
(window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = TestPointerEvent;
const snap: StudioSnapshot = { png: 'iVBORw0KGgo=', capturedAt: '2026-11-14T00:00:00.000Z', root: { ref: '@e0', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
  { ref: '@e1', role: 'button', name: '가운데', rect: { x: 540, y: 1200, width: 108, height: 240 } },
] } };
function setup(extra: { selectedRef?: string; onSelectNode?: (ref: string) => void } = {}) {
  const calls: string[] = [];
  const api = {
    tap: async (d: string, x: number, y: number) => { calls.push(`tap ${d} ${x},${y}`); },
    swipe: async (d: string, a: { x: number; y: number }, b: { x: number; y: number }, ms: number) => { calls.push(`swipe ${d} ${a.x},${a.y}->${b.x},${b.y} ${ms}`); },
    text: async (d: string, t: string) => { calls.push(`text ${d} ${t}`); },
    key: async (d: string, k: string) => { calls.push(`key ${d} ${k}`); },
    button: async (d: string, b: string) => { calls.push(`button ${d} ${b}`); },
  } as unknown as StudioApi;
  const changed = vi.fn();
  const view = render(<DevicePanel api={api} deviceId="SER1" deviceLabel="SM-N981N (…SER1)" snapshot={snap} onInput={changed} {...extra} />);
  const img = screen.getByRole('img', { name: /기기 화면/ }) as HTMLImageElement;
  // jsdom 은 레이아웃이 없다: 표시 크기와 원본 크기를 정해 준다
  Object.defineProperty(img, 'naturalWidth', { value: 1080 }); Object.defineProperty(img, 'naturalHeight', { value: 2400 });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  return { calls, img, changed, view, api };
}

describe('DevicePanel', () => {
  it('스냅샷을 그림으로', () => {
    const { img } = setup();
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${snap.png}`);
  });

  it('클릭(움직임 10px 미만)은 그 자리의 기기 픽셀 탭, 그리고 onInput', async () => {
    const { calls, img, changed } = setup();
    await act(async () => { fireEvent.pointerDown(img, { clientX: 200, clientY: 300 }); fireEvent.pointerUp(img, { clientX: 203, clientY: 302 }); });
    expect(calls).toEqual(['tap SER1 540,1200']);
    expect(changed).toHaveBeenCalled();
  });

  it('드래그는 스와이프(시작·끝 기기 픽셀, 끌린 시간 범위 안)', async () => {
    const { calls, img } = setup();
    await act(async () => { fireEvent.pointerDown(img, { clientX: 200, clientY: 500 }); fireEvent.pointerUp(img, { clientX: 200, clientY: 100 }); });
    expect(calls[0]).toMatch(/^swipe SER1 540,2000->540,400 \d+$/);
  });

  it('여백 클릭은 무시', async () => {
    const { calls, img } = setup();
    await act(async () => { fireEvent.pointerDown(img, { clientX: 10, clientY: 300 }); fireEvent.pointerUp(img, { clientX: 10, clientY: 300 }); });
    expect(calls).toEqual([]);
  });

  it('화면에 초점을 두고 치면 글자는 모아서 입력, Enter·Backspace 는 키', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls, img } = setup();
    fireEvent.keyDown(img, { key: 'a' }); fireEvent.keyDown(img, { key: 'b' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    fireEvent.keyDown(img, { key: 'Enter' });
    fireEvent.keyDown(img, { key: 'Backspace' });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(calls).toEqual(['text SER1 ab', 'key SER1 enter', 'key SER1 backspace']);
  });

  it('뒤로·홈 버튼', async () => {
    const { calls } = setup();
    await act(async () => { screen.getByRole('button', { name: '뒤로' }).click(); screen.getByRole('button', { name: '홈' }).click(); });
    expect(calls).toEqual(['button SER1 back', 'button SER1 home']);
  });
});

describe('DevicePanel · Inspector 연동(studio 04)', () => {
  it('고른 노드를 화면 위에 하이라이트(기기 픽셀 → 표시 좌표)', () => {
    const { view, api } = setup();
    view.rerender(<DevicePanel api={api} deviceId="SER1" snapshot={snap} selectedRef="@e1" />);
    const box = screen.getByLabelText('선택한 노드 영역');
    // 배율 270/1080 = 0.25, 좌우 여백 65
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['200px', '300px', '27px', '60px']);
  });

  it('하이라이트는 화면을 가리지 않는다: 채움은 반투명(테마의 muted 색은 다크에서 불투명 #474747 이라 화면 전체 크기 노드를 고르면 화면이 사라진 것처럼 보였다)', () => {
    const { view, api } = setup();
    view.rerender(<DevicePanel api={api} deviceId="SER1" snapshot={snap} selectedRef="@e1" />);
    const box = screen.getByLabelText('선택한 노드 영역');
    expect(box.style.background).not.toContain('--color-accent-muted');
    expect(box.style.background).toMatch(/transparent/);
  });

  it('화면을 클릭하면 탭과 함께 그 자리의 가장 안쪽 노드를 고른다', async () => {
    const picked: string[] = [];
    const { calls, img } = setup({ onSelectNode: (r) => picked.push(r) });
    await act(async () => { fireEvent.pointerDown(img, { clientX: 205, clientY: 310 }); fireEvent.pointerUp(img, { clientX: 205, clientY: 310 }); });
    expect(picked).toEqual(['@e1']);
    expect(calls[0]).toMatch(/^tap SER1/);
  });
});
