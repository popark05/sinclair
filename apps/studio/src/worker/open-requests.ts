// Console → Studio 열기 요청(studio-console 06): 설정의 control-plane 에서 연결된 기기들의 요청을 가져오고, 처리하면 ack.
export interface OpenRequestView { id: string; deviceId: string; goal?: string; app?: string; from?: { cycleId?: string; testId?: string; targetId?: string }; createdAt: string }

export async function fetchOpenRequests(input: { controlPlane: string; devices: string[] }): Promise<OpenRequestView[]> {
  if (!input.devices.length) return [];
  const res = await fetch(`${input.controlPlane.replace(/\/+$/, '')}/studio/open-requests?devices=${encodeURIComponent(input.devices.join(','))}`);
  if (!res.ok) throw new Error(`control-plane 열기 요청: HTTP ${res.status}`);
  return ((await res.json()) as { requests: OpenRequestView[] }).requests;
}

export async function ackOpenRequest(input: { controlPlane: string; id: string }): Promise<null> {
  const res = await fetch(`${input.controlPlane.replace(/\/+$/, '')}/studio/open-requests/${encodeURIComponent(input.id)}/ack`, { method: 'POST' });
  if (!res.ok && res.status !== 404) throw new Error(`control-plane 열기 요청 ack: HTTP ${res.status}`);
  return null;
}
