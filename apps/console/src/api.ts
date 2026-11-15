// control-plane HTTP API 클라이언트. 응답 모양은 control-plane 의 타입을 type 으로만 가져온다(apps 끼리 런타임 import 없음).
import type { CycleSummary, CycleUsage, CycleViewWithWarnings, FleetView, HistoryView, IssueCategory, IssueView, RunView } from '@sinclair/control-plane';

export type { CycleSummary, CycleUsage, CycleViewWithWarnings, FleetView, HistoryView, IssueCategory, IssueView, RunView };
export interface TriagePatch { category: IssueCategory | null; note: string; ticketUrl?: string }

/** 화면에 그대로 보일 오류. status 가 없으면 서버에 닿지 못한 것 */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface StudioOpenRequest { deviceId: string; goal?: string; app?: string; from?: { cycleId?: string; testId?: string; targetId?: string } }

export interface Api {
  cycleSummaries(limit?: number): Promise<CycleSummary[]>;
  cycle(cycleId: string): Promise<CycleViewWithWarnings>;
  run(runId: string): Promise<RunView>;
  fleet(): Promise<FleetView>;
  /** 보고가 끊긴(offline) 노드 기록 삭제. 보고 중인 노드는 409 */
  deleteNode(agentId: string): Promise<void>;
  usage(cycleId: string): Promise<CycleUsage>;
  history(opts: { limit: number; testId?: string }): Promise<HistoryView>;
  issues(limit: number): Promise<IssueView[]>;
  triage(id: string, patch: TriagePatch): Promise<object>;
  /** Console → Studio 열기 요청(studio-console 05): 그 기기가 연결된 Studio 가 기기를 고르고 목표를 채운다 */
  openInStudio(req: StudioOpenRequest): Promise<{ id: string }>;
  /** sinclair:// 링크 열기(설치본 Studio 를 앞으로, studio-packaging 03). 설치돼 있지 않으면 브라우저가 무시하거나 묻는다 — 요청은 중계로도 닿는다 */
  launchStudio(url: string): void;
  /** 아티팩트(스크린샷·화면 트리) 주소 — 그림·링크로 바로 쓴다 */
  artifactUrl(runId: string, key: string): string;
}

/** baseUrl: control-plane 주소. 같은 서버가 Console 을 서빙하면 '' (같은 출처) */
export function createApi(baseUrl = '', fetchImpl: typeof fetch = (...a) => fetch(...a)): Api {
  const get = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`${baseUrl}${path}`, init); } catch (err) {
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
    deleteNode: (agentId) => get(`/fleet/nodes/${id(agentId)}`, { method: 'DELETE' }),
    usage: (cycleId) => get(`/cycles/${id(cycleId)}/usage`),
    issues: (limit) => get(`/issues?limit=${limit}`),
    openInStudio: (r) => get('/studio/open-requests', { method: 'POST', body: JSON.stringify(r) }),
    launchStudio: (url) => { window.location.assign(url); },
    triage: (issueId, patch) => get(`/issues/${id(issueId)}`, { method: 'PUT', body: JSON.stringify(patch) }),
    artifactUrl: (runId, key) => `${baseUrl}/artifacts/${id(runId)}/${id(key)}`,
    history: ({ limit, testId }) => get(`/tests/history?limit=${limit}${testId ? `&testId=${id(testId)}` : ''}`),
  };
}
