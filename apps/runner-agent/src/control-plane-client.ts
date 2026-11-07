// control-plane 과의 얇은 HTTP 클라이언트(Run 등록). 전송 자체는 러너의 HTTP Reporter 가 한다.
export class ControlPlaneError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface RegisteredRun { runId: string; cycleId: string; targetId: string }

export async function registerRun(controlPlane: string, cycleId: string, targetId: string, runId?: string, doFetch: typeof fetch = fetch): Promise<RegisteredRun> {
  const base = controlPlane.replace(/\/$/, '');
  let res: Response;
  try {
    res = await doFetch(`${base}/cycles/${encodeURIComponent(cycleId)}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId, ...(runId ? { runId } : {}) }) });
  } catch (err) {
    throw new ControlPlaneError(`control-plane 에 연결할 수 없음(${base}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 201) return (await res.json()) as RegisteredRun;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 409 && runId) return { runId, cycleId, targetId }; // 이미 등록된 Run 을 지정한 경우(재시도·resume)
  throw new ControlPlaneError(`Run 등록 실패 ${res.status}: ${body.error ?? ''}`, res.status);
}
