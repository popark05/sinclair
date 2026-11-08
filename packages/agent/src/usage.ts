// 토큰 사용량 합산. 캐시 필드는 어느 한쪽이라도 보고했을 때만 남긴다(없던 0 을 만들지 않는다)
import type { StepUsage } from '@sinclair/protocol';

export function addUsage(a: StepUsage | undefined, b: StepUsage | undefined): StepUsage | undefined {
  if (!a) return b && { ...b };
  if (!b) return a;
  const opt = (k: 'cacheReadTokens' | 'cacheWriteTokens') => (a[k] === undefined && b[k] === undefined ? {} : { [k]: (a[k] ?? 0) + (b[k] ?? 0) });
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, ...opt('cacheReadTokens'), ...opt('cacheWriteTokens') };
}
