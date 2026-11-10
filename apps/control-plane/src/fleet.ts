// Fleet: 노드(runner-agent)가 보고한 기기들과 그 상태. 상태는 저장하지 않고 조회 시점에 보고와 시계로 계산한다(Verdict 와 같은 방식).
// 규칙: 노드 보고가 TTL 을 넘기거나 기기가 보고에서 빠지면 offline, 아니면 미승인·연결 끊김·헬퍼 미준비·잠김이 untrusted(사유), 나머지 idle. leased 는 기기 lease(device-fleet 02)가 생기면.
// 구현체는 test/fleet.test.ts 의 FleetStore 계약을 통과해야 한다.
import { nodeDeviceProblem, type DeviceState, type NodeDevice, type NodeReport } from '@sinclair/protocol';

/** 보고에서 빠진 기기: 마지막으로 보인 모습과 처음 빠진 시각. 다시 보고되면 사라진다. 뽑힌 기기(lease 중이던 기기 포함)를 "사라짐" 이 아니라 offline 으로 보이게 한다 */
export type MissingDevice = NodeDevice & { missingSince: string };
export interface NodeRecord { agentId: string; reportedAt: string; devices: NodeDevice[]; missing: MissingDevice[] }

/** 이전 기록과 새 보고로 다음 기록을 만든다(두 저장소가 같은 규칙을 쓴다) */
export function nextNodeRecord(prev: NodeRecord | undefined, agentId: string, report: NodeReport, nowMs: number): NodeRecord {
  const at = new Date(nowMs).toISOString();
  const present = new Set(report.devices.map((d) => d.id));
  const stillMissing = (prev?.missing ?? []).filter((d) => !present.has(d.id));
  const newlyMissing = (prev?.devices ?? []).filter((d) => !present.has(d.id) && !stillMissing.some((m) => m.id === d.id)).map((d) => ({ ...d, missingSince: at }));
  return { agentId, reportedAt: at, devices: report.devices.map((d) => ({ ...d })), missing: [...stillMissing, ...newlyMissing] };
}

export interface FleetStore {
  /** 노드 보고로 기기 목록을 바꾼다. 보고에서 빠진 기기는 missing 으로 옮긴다(nextNodeRecord). 같은 보고를 반복해도 결과가 같다 */
  reportNode(agentId: string, report: NodeReport, nowMs: number): Promise<void>;
  /** 처음 보고한 순서 */
  listNodes(): Promise<NodeRecord[]>;
  /** 노드 기록을 지운다. 마지막 보고가 reportedBefore(ISO)보다 이를 때만 — 판단과 삭제 사이에 다시 보고한 노드는 recent 로 남긴다. 다시 보고하면 새 노드로 나타난다 */
  deleteNode(agentId: string, reportedBefore: string): Promise<'deleted' | 'recent' | 'no-node'>;
  /** 마지막 보고가 reportedBefore(ISO)보다 이른 노드를 모두 지우고 그 id 를 돌려준다(보존 기간 정리) */
  pruneNodes(reportedBefore: string): Promise<string[]>;
  close?(): Promise<void>;
}

export interface DeviceStatus { state: DeviceState; reason?: string }

/** 노드 보고 시각과 기기 보고로 지금의 상태를 계산한다. helper·locked 가 없으면(그 플랫폼에 개념이 없거나 확인 못 함) 막지 않는다 */
export function deviceStatus(device: NodeDevice, reportedAtMs: number, nowMs: number, nodeTtlMs: number): DeviceStatus {
  if (nowMs - reportedAtMs >= nodeTtlMs) return { state: 'offline', reason: '노드 보고 끊김' };
  const problem = nodeDeviceProblem(device); // 노드가 클레임 후보를 거르는 규칙과 같다
  return problem ? { state: 'untrusted', reason: problem } : { state: 'idle' };
}

export interface FleetView {
  nodeTtlMs: number;
  /** 기기 상태에 lease 중이면 runId 가 붙는다 */
  nodes: Array<{ agentId: string; reportedAt: string; online: boolean; devices: Array<NodeDevice & DeviceStatus & { runId?: string }> }>;
}

/** leases: 지금 바쁜 기기 → 그 Run(끝난 Run 은 호출자가 뺀다). 쓸 수 있는(idle) 기기만 leased 로 바뀌고, 잠김·뽑힘 같은 문제는 lease 중이어도 그대로 보인다(runId 는 붙는다) */
export function buildFleetView(nodes: NodeRecord[], nowMs: number, nodeTtlMs: number, leases: ReadonlyMap<string, string> = new Map()): FleetView {
  return {
    nodeTtlMs,
    nodes: nodes.map((n) => {
      const at = Date.parse(n.reportedAt);
      const withLease = <D extends NodeDevice & DeviceStatus>(d: D): D & { runId?: string } => {
        const runId = leases.get(d.id);
        if (!runId) return d;
        return { ...d, ...(d.state === 'idle' ? { state: 'leased' as const } : {}), runId };
      };
      const missing = n.missing.map(({ missingSince: _m, ...d }) => withLease({ ...d, state: 'offline' as const, reason: '보고에서 빠짐' }));
      return { agentId: n.agentId, reportedAt: n.reportedAt, online: nowMs - at < nodeTtlMs, devices: [...n.devices.map((d) => withLease({ ...d, ...deviceStatus(d, at, nowMs, nodeTtlMs) })), ...missing] };
    }),
  };
}

export function createMemoryFleetStore(): FleetStore {
  const nodes = new Map<string, NodeRecord>(); // Map 은 삽입 순서를 지키므로 첫 보고 순서가 유지된다
  return {
    async reportNode(agentId, report, nowMs) {
      nodes.set(agentId, nextNodeRecord(nodes.get(agentId), agentId, report, nowMs));
    },
    async listNodes() {
      return [...nodes.values()].map((n) => ({ ...n, devices: n.devices.map((d) => ({ ...d })), missing: n.missing.map((d) => ({ ...d })) }));
    },
    async deleteNode(agentId, reportedBefore) {
      const n = nodes.get(agentId);
      if (!n) return 'no-node';
      if (n.reportedAt >= reportedBefore) return 'recent';
      nodes.delete(agentId);
      return 'deleted';
    },
    async pruneNodes(reportedBefore) {
      const gone = [...nodes.values()].filter((n) => n.reportedAt < reportedBefore).map((n) => n.agentId);
      for (const id of gone) nodes.delete(id);
      return gone;
    },
  };
}
