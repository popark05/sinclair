// Fleet: 노드(runner-agent)가 보고한 기기들과 그 상태. 상태는 저장하지 않고 조회 시점에 보고와 시계로 계산한다(Verdict 와 같은 방식).
// 규칙: 노드 보고가 TTL 을 넘기면 offline, 아니면 미승인·연결 끊김·헬퍼 미준비·잠김이 untrusted(사유), 나머지 idle. leased 는 기기 lease(device-fleet 02)가 생기면.
// 구현체는 test/fleet.test.ts 의 FleetStore 계약을 통과해야 한다.
import type { DeviceState, NodeDevice, NodeReport } from '@sinclair/protocol';

export interface NodeRecord { agentId: string; reportedAt: string; devices: NodeDevice[] }

export interface FleetStore {
  /** 노드 보고를 통째로 바꾼다(보고에서 빠진 기기는 사라진다). 같은 보고를 반복해도 결과가 같다 */
  reportNode(agentId: string, report: NodeReport, nowMs: number): Promise<void>;
  /** 처음 보고한 순서 */
  listNodes(): Promise<NodeRecord[]>;
  close?(): Promise<void>;
}

export interface DeviceStatus { state: DeviceState; reason?: string }

/** 노드 보고 시각과 기기 보고로 지금의 상태를 계산한다. helper·locked 가 없으면(그 플랫폼에 개념이 없거나 확인 못 함) 막지 않는다 */
export function deviceStatus(device: NodeDevice, reportedAtMs: number, nowMs: number, nodeTtlMs: number): DeviceStatus {
  if (nowMs - reportedAtMs >= nodeTtlMs) return { state: 'offline', reason: '노드 보고 끊김' };
  if (device.connection === 'unauthorized') return { state: 'untrusted', reason: 'USB 디버깅 미승인' };
  if (device.connection === 'offline') return { state: 'untrusted', reason: '기기 연결 응답 없음(adb offline)' };
  if (device.helper !== undefined && device.helper !== 'ready') return { state: 'untrusted', reason: `헬퍼 준비 안 됨(${device.helper})` };
  if (device.locked) return { state: 'untrusted', reason: '화면 잠김' };
  return { state: 'idle' };
}

export interface FleetView {
  nodeTtlMs: number;
  nodes: Array<{ agentId: string; reportedAt: string; online: boolean; devices: Array<NodeDevice & DeviceStatus> }>;
}

export function buildFleetView(nodes: NodeRecord[], nowMs: number, nodeTtlMs: number): FleetView {
  return {
    nodeTtlMs,
    nodes: nodes.map((n) => {
      const at = Date.parse(n.reportedAt);
      return { agentId: n.agentId, reportedAt: n.reportedAt, online: nowMs - at < nodeTtlMs, devices: n.devices.map((d) => ({ ...d, ...deviceStatus(d, at, nowMs, nodeTtlMs) })) };
    }),
  };
}

export function createMemoryFleetStore(): FleetStore {
  const nodes = new Map<string, NodeRecord>(); // Map 은 삽입 순서를 지키므로 첫 보고 순서가 유지된다
  return {
    async reportNode(agentId, report, nowMs) {
      nodes.set(agentId, { agentId, reportedAt: new Date(nowMs).toISOString(), devices: report.devices.map((d) => ({ ...d })) });
    },
    async listNodes() {
      return [...nodes.values()].map((n) => ({ ...n, devices: n.devices.map((d) => ({ ...d })) }));
    },
  };
}
