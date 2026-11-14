// Studio IPC 계약(studio 01): 메인 ↔ 작업 프로세스 메시지는 단일 정의와 닫힌 검사기를 지난다(구조화 복제 가능한 평범한 데이터).
import { describe, it, expect } from 'vitest';
import { parseFromWorker, STUDIO_CHANNELS } from '../src/shared/studio-ipc.ts';

describe('studio IPC 계약', () => {
  it('작업 프로세스 메시지: ready·pong 만, 필드가 맞을 때만 통과', () => {
    expect(parseFromWorker({ type: 'ready', node: 'v24.13.0', pid: 12 })).toEqual({ type: 'ready', node: 'v24.13.0', pid: 12 });
    expect(parseFromWorker({ type: 'pong', id: 'p1', node: 'v24.13.0', pid: 12 })).toEqual({ type: 'pong', id: 'p1', node: 'v24.13.0', pid: 12 });
    for (const bad of [null, 'x', { type: 'eval', code: '1' }, { type: 'pong', id: 1, node: 'v', pid: 1 }, { type: 'ready', node: 'v', pid: '1' }]) expect(parseFromWorker(bad)).toBeUndefined();
  });

  it('렌더러 채널 이름은 studio: 접두사로 겹치지 않는다', () => {
    const names = Object.values(STUDIO_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^studio:/);
  });
});
