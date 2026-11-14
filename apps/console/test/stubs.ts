// 가짜 API 의 기본값: 그 테스트가 보지 않는 메서드(모델 사용·이력)는 빈 결과를 준다.
const zero = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null };
export const STUBS = {
  usage: async (cycleId: string) => ({ cycleId, total: zero, byTarget: {}, byTest: {}, byModel: {} }),
  history: async () => ({ cycles: [], tests: [] }),
  issues: async () => [],
  triage: async (id: string, patch: object) => ({ id, ...patch }),
  deleteNode: async () => undefined,
  openInStudio: async () => ({ id: 'req-1' }),
  artifactUrl: (runId: string, key: string) => `/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(key)}`,
};
