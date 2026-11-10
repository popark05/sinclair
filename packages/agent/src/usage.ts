// 토큰 사용량 합산. 캐시 필드는 어느 한쪽이라도 보고했을 때만 남긴다(없던 0 을 만들지 않는다)
import type { StepUsage, TokenUsage } from '@sinclair/protocol';

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  const opt = (k: 'cacheReadTokens' | 'cacheWriteTokens') => (a[k] === undefined && b[k] === undefined ? {} : { [k]: (a[k] ?? 0) + (b[k] ?? 0) });
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, ...opt('cacheReadTokens'), ...opt('cacheWriteTokens') };
}

/** 합계와 모델별 내역을 함께 더한다. 내역은 어느 한쪽이라도 있으면 남긴다(같은 모델은 합침) */
export function addUsage(a: StepUsage | undefined, b: StepUsage | undefined): StepUsage | undefined {
  if (!a) return b && structuredClone(b);
  if (!b) return a;
  const total = addTokens(a, b);
  if (!a.byModel && !b.byModel) return total;
  const byModel: Record<string, TokenUsage> = { ...structuredClone(a.byModel ?? {}) };
  for (const [m, u] of Object.entries(b.byModel ?? {})) byModel[m] = byModel[m] ? addTokens(byModel[m]!, u) : { ...u };
  return { ...total, byModel };
}
