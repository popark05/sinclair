// @vitest-environment jsdom
// 렌더러(studio 01): astryx ide 틀 위의 4영역(기기·세션 탭·Inspector·로그 드로어)과 작업 프로세스 상태.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Workspace } from '../src/renderer/src/Workspace.tsx';
import type { StudioApi, WorkerStatus } from '../src/shared/studio-ipc.ts';

afterEach(cleanup);
const api = (status: WorkerStatus): StudioApi => ({ getWorkerStatus: async () => status, onWorkerStatus: () => () => {}, ping: async () => ({ roundTripMs: 3, node: 'v24.13.0' }),
  connection: async () => ({ mode: 'own', detail: '직접' }), listDevices: async () => [], foregroundApp: async () => null }) as unknown as StudioApi;

describe('Workspace', () => {
  it('기기·세션·Inspector·로그 네 영역', async () => {
    render(<Workspace api={api({ state: 'ready', node: 'v24.13.0', pid: 1 })} />);
    for (const name of ['기기', '세션', 'Inspector', '로그']) expect(await screen.findByRole('region', { name })).toBeTruthy();
  });

  it('로그 드로어에 작업 프로세스 상태(Node 버전)', async () => {
    render(<Workspace api={api({ state: 'ready', node: 'v24.13.0', pid: 1 })} />);
    expect((await screen.findByRole('region', { name: '로그' })).textContent).toMatch(/작업 프로세스.*준비됨.*v24\.13\.0/);
  });

  it('작업 프로세스가 죽었으면 그 사유', async () => {
    render(<Workspace api={api({ state: 'exited', error: 'spawn node ENOENT' })} />);
    expect((await screen.findByRole('region', { name: '로그' })).textContent).toMatch(/종료됨.*ENOENT/);
  });
});
