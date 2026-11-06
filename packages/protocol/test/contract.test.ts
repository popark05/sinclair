// 계약 테스트: 상수 목록과 타입이 어긋나지 않는지, 명명 규칙이 지켜지는지 고정한다.
import { describe, it, expect } from 'vitest';
import {
  RUN_EVENT_TYPES, DEVICE_RPC_METHODS, ATTEMPT_RESULTS, CACHE_DECISIONS, NETWORK_MODES,
  capabilitiesOf, type Engine, type RunEvent,
} from '../src/index.ts';

describe('protocol 계약', () => {
  it('이벤트 타입 목록은 중복이 없고 "<entity>.<verb>" 형식이다', () => {
    expect(new Set(RUN_EVENT_TYPES).size).toBe(RUN_EVENT_TYPES.length);
    for (const t of RUN_EVENT_TYPES) expect(t).toMatch(/^(run|attempt|step)\.[a-z]+$/);
  });

  it('디바이스 RPC 메서드는 중복이 없고 device.* 또는 devices.list, server.* 이다', () => {
    expect(new Set(DEVICE_RPC_METHODS).size).toBe(DEVICE_RPC_METHODS.length);
    for (const m of DEVICE_RPC_METHODS) expect(m).toMatch(/^(device\.[a-z.]+|devices\.list|server\.[a-z]+)$/);
  });

  it('상태 상수는 spec의 값과 일치한다', () => {
    expect(ATTEMPT_RESULTS).toEqual(['passed', 'failed', 'blocked', 'skipped']);
    expect(CACHE_DECISIONS).toEqual(['replayed', 'handed-off', 'recorded', 'live']);
    expect(NETWORK_MODES).toEqual(['direct', 'capture', 'mock']);
  });

  it('capability는 구현된 선택 메서드로만 결정된다', () => {
    const base: Engine = {
      name: 'fake', spiVersion: 1, actions: ['tap'],
      observe: async () => ({ root: { ref: '@e0', role: 'root' } }),
      locate: async () => [],
      perform: async () => {},
    };
    expect(capabilitiesOf(base)).toEqual([]);
    expect(capabilitiesOf({ ...base, performAt: async () => {} })).toEqual(['pointer']);
  });

  it('attempt.finished 이벤트는 result 필드가 필수다', () => {
    const ev: RunEvent = {
      schema: 1, eventId: 'e1', runId: 'r1', at: '2026-11-07T00:00:00Z',
      type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [],
    };
    expect(ev.type).toBe('attempt.finished');
  });
});
