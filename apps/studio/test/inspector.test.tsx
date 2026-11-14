// @vitest-environment jsdom
// Inspector(studio 04): 트리 선택 → 속성·locator 후보(매치 수, 1 이 아니면 경고), 복사.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, act } from '@testing-library/react';
import { Inspector } from '../src/renderer/src/Inspector.tsx';
import type { StudioSnapshot } from '../src/shared/studio-ipc.ts';

afterEach(cleanup);
const snap: StudioSnapshot = { png: '', capturedAt: 'x', root: { ref: '@e0', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [
  { ref: '@e2', role: 'button', name: '검색', testId: 'com.app:id/search', rect: { x: 900, y: 50, width: 120, height: 100 } },
  { ref: '@e3', role: 'button', name: '검색', rect: { x: 700, y: 50, width: 120, height: 100 } },
] } };

describe('Inspector', () => {
  it('트리의 노드를 고르면 onSelect, 고른 노드의 locator 후보와 매치 수(2 면 경고)', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Inspector snapshot={snap} selectedRef={undefined} onSelect={onSelect} />);
    await act(async () => { screen.getByText('button "검색" · search').click(); });
    expect(onSelect).toHaveBeenCalledWith('@e2');
    rerender(<Inspector snapshot={snap} selectedRef="@e2" onSelect={onSelect} />);
    const list = screen.getByRole('list', { name: 'locator 후보' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/getByTestId\('com\.app:id\/search'\).*1개/);
    expect(rows[1]!.textContent).toMatch(/getByRole\('button', \{ name: '검색', exact: true \}\).*2개.*하나로 정해지지 않음/);
  });

  it('복사 버튼은 그 코드를 클립보드에', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Inspector snapshot={snap} selectedRef="@e2" onSelect={() => {}} />);
    await act(async () => { within(screen.getByRole('list', { name: 'locator 후보' })).getAllByRole('button', { name: '복사' })[0]!.click(); });
    expect(writeText).toHaveBeenCalledWith("screen.getByTestId('com.app:id/search')");
  });

  it('스냅샷이 없으면 안내', () => {
    render(<Inspector snapshot={undefined} selectedRef={undefined} onSelect={() => {}} />);
    expect(screen.getByText('화면 트리 없음')).toBeTruthy();
  });
});
