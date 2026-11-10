// control-plane HTTP API 클라이언트. 응답 모양은 control-plane 의 타입을 type 으로만 가져온다(apps 끼리 런타임 import 없음).
import type { CycleSummary, CycleUsage, CycleViewWithWarnings, FleetView, HistoryView, RunView } from '@sinclair/control-plane';

export type { CycleSummary, CycleUsage, CycleViewWithWarnings, FleetView, HistoryView, RunView };

/** 화면에 그대로 보일 오류. status 가 없으면 서버에 닿지 못한 것 */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface Api {
  cycleSummaries(limit?: number): Promise<CycleSummary[]>;
  cycle(cycleId: string): Promise<CycleViewWithWarnings>;
  run(runId: string): Promise<RunView>;
  fleet(): Promise<FleetView>;
  usage(cycleId: string): Promise<CycleUsage>;
  history(opts: { limit: number; testId?: string }): Promise<HistoryView>;
  /** 아티팩트(스크린샷·화면 트리) 주소 — 그림·링크로 바로 쓴다 */
  artifactUrl(runId: string, key: string): string;
}

/** baseUrl: control-plane 주소. 같은 서버가 Console 을 서빙하면 '' (같은 출처) */
export function createApi(baseUrl = '', fetchImpl: typeof fetch = (...a) => fetch(...a)): Api {
  const get = async <T>(path: string): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`${baseUrl}${path}`); } catch (err) {
      throw new ApiError(`control-plane 에 닿지 않음: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    if (!res.ok) {
      const msg = body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string' ? (body as { error: string }).error : res.statusText;
      throw new ApiError(`${res.status} ${msg}`, res.status);
    }
    return body as T;
  };
  const id = encodeURIComponent;
  return {
    cycleSummaries: (limit = 50) => get(`/cycles/summary?limit=${limit}`),
    cycle: (cycleId) => get(`/cycles/${id(cycleId)}`),
    run: (runId) => get(`/runs/${id(runId)}`),
    fleet: () => get('/fleet'),
    usage: (cycleId) => get(`/cycles/${id(cycleId)}/usage`),
    artifactUrl: (runId, key) => `${baseUrl}/artifacts/${id(runId)}/${id(key)}`,
    history: ({ limit, testId }) => get(`/tests/history?limit=${limit}${testId ? `&testId=${id(testId)}` : ''}`),
  };
}
