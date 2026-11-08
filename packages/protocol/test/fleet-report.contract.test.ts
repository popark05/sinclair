// 노드 기기 보고(runner-agent → control-plane PUT /fleet/nodes/:agentId) 계약: 닫힌 검증기. 모르는 필드·잘못된 값은 거부한다.
import { describe, it, expect } from 'vitest';
import { parseNodeReport, HELPER_STATES, DEVICE_CONNECTION_STATES, type NodeReport } from '../src/index.ts';

const ok: NodeReport = {
  devices: [
    { id: 'SER1', platform: 'android', model: 'SM-N981N', osVersion: '13', connection: 'device', helper: 'ready', locked: false },
    { id: 'SER2', platform: 'android', model: 'Pixel 7', osVersion: '14', connection: 'unauthorized' },
  ],
};

describe('parseNodeReport', () => {
  it('올바른 보고를 그대로 받는다(helper·locked 는 선택)', () => {
    expect(parseNodeReport(ok)).toEqual({ ok: true, value: ok });
    expect(parseNodeReport({ devices: [] })).toEqual({ ok: true, value: { devices: [] } });
  });

  it('기기별 오류를 경로와 함께 모은다', () => {
    const r = parseNodeReport({ devices: [{ id: '', platform: 'windows', model: 1, osVersion: '13', connection: 'gone', helper: 'maybe', locked: 'no', extra: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/devices\[0\]\.id/), expect.stringMatching(/devices\[0\]\.platform/), expect.stringMatching(/devices\[0\]\.model/),
      expect.stringMatching(/devices\[0\]\.connection/), expect.stringMatching(/devices\[0\]\.helper/), expect.stringMatching(/devices\[0\]\.locked/),
      expect.stringMatching(/devices\[0\]\.extra/),
    ]));
  });

  it('같은 id 가 두 번이면 거부, devices 배열이 없으면 거부', () => {
    expect(parseNodeReport({ devices: [ok.devices[0], ok.devices[0]] }).ok).toBe(false);
    expect(parseNodeReport({}).ok).toBe(false);
    expect(parseNodeReport('x').ok).toBe(false);
  });

  it('허용 값은 프로토콜 상수와 같다(드리프트 방지)', () => {
    for (const helper of HELPER_STATES) expect(parseNodeReport({ devices: [{ ...ok.devices[0]!, helper }] }).ok).toBe(true);
    for (const connection of DEVICE_CONNECTION_STATES) expect(parseNodeReport({ devices: [{ ...ok.devices[0]!, connection }] }).ok).toBe(true);
  });
});
