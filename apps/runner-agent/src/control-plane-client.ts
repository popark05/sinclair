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
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  // 409 는 "끝난 Cycle" 과 "이미 있는 Run" 둘 다라 상태 코드가 아니라 code 로 가른다. 지정한 Run 이 이미 있으면 재사용(재시도·resume)
  if (res.status === 409 && body.code === 'run-exists' && runId) return { runId, cycleId, targetId };
  throw new ControlPlaneError(`Run 등록 실패 ${res.status}${body.code ? ` (${body.code})` : ''}: ${body.error ?? ''}`, res.status);
}
