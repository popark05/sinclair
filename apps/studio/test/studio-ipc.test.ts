// Studio IPC 계약(studio 01): 메인 ↔ 작업 프로세스 메시지는 단일 정의와 닫힌 검사기를 지난다(구조화 복제 가능한 평범한 데이터).
import { describe, it, expect } from 'vitest';
import { parseFromWorker, parseStudioRequest, STUDIO_CHANNELS } from '../src/shared/studio-ipc.ts';

describe('studio IPC 계약', () => {
  it('작업 프로세스 메시지: ready·pong 만, 필드가 맞을 때만 통과', () => {
    expect(parseFromWorker({ type: 'ready', node: 'v24.13.0', pid: 12 })).toEqual({ type: 'ready', node: 'v24.13.0', pid: 12 });
    expect(parseFromWorker({ type: 'pong', id: 'p1', node: 'v24.13.0', pid: 12 })).toEqual({ type: 'pong', id: 'p1', node: 'v24.13.0', pid: 12 });
    for (const bad of [null, 'x', { type: 'eval', code: '1' }, { type: 'pong', id: 1, node: 'v', pid: 1 }, { type: 'ready', node: 'v', pid: '1' }]) expect(parseFromWorker(bad)).toBeUndefined();
  });

  it('응답 메시지와 렌더러 요청: 알려진 요청만, 기기 id 는 문자열', () => {
    expect(parseFromWorker({ type: 'response', id: 'r1', ok: true, value: [] })).toEqual({ type: 'response', id: 'r1', ok: true, value: [] });
    expect(parseFromWorker({ type: 'response', id: 'r1', ok: false, error: '실패' })).toEqual({ type: 'response', id: 'r1', ok: false, error: '실패' });
    expect(parseStudioRequest({ kind: 'devices' })).toEqual({ kind: 'devices' });
    expect(parseStudioRequest({ kind: 'connection' })).toEqual({ kind: 'connection' });
    expect(parseStudioRequest({ kind: 'foreground-app', deviceId: 'SER' })).toEqual({ kind: 'foreground-app', deviceId: 'SER' });
    for (const bad of [{ kind: 'shell', cmd: 'rm' }, { kind: 'foreground-app' }, { kind: 'foreground-app', deviceId: 3 }, null]) expect(parseStudioRequest(bad)).toBeUndefined();
  });

  it('렌더러 채널 이름은 studio: 접두사로 겹치지 않는다', () => {
    const names = Object.values(STUDIO_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^studio:/);
  });
});
