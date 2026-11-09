// 환경변수 → agent.act 설정 한 벌(실행기 + 한도). runner-agent 가 runTests 의 agent 옵션으로 넘긴다.
// 실행기 설정은 claudeOptionsFromEnv, act 한도는 SINCLAIR_AGENT_ACT_MAX_TURNS·SINCLAIR_AGENT_ACT_TIMEOUT_MS. 잘못된 값은 ModelConfigError
import { claudeOptionsFromEnv, createClaudeExecutor, envInt } from './claude.ts';
import { ModelConfigError, type StepExecutor } from './executor.ts';
import { piiFromEnv, type PiiFilter } from './pii.ts';

export interface AgentSetup { executor: StepExecutor; maxTurns?: number; timeoutMs?: number; safetyNet?: { pixels?: boolean }; incidents?: { permission?: 'allow' | 'deny' }; pii?: PiiFilter }

export function agentFromEnv(env: Record<string, string | undefined> = process.env): AgentSetup {
  const executor = createClaudeExecutor(claudeOptionsFromEnv(env));
  const maxTurns = envInt(env, 'SINCLAIR_AGENT_ACT_MAX_TURNS', 1, 200);
  const timeoutMs = envInt(env, 'SINCLAIR_AGENT_ACT_TIMEOUT_MS', 1000, 3_600_000);
  const sp = env.SINCLAIR_AGENT_ACT_SAFETY_PIXELS;
  if (sp && sp !== '0' && sp !== '1') throw new ModelConfigError(`SINCLAIR_AGENT_ACT_SAFETY_PIXELS=${JSON.stringify(sp)}: 1 또는 0 이어야 함`);
  const perm = env.SINCLAIR_AGENT_ACT_PERMISSION;
  if (perm && perm !== 'allow' && perm !== 'deny') throw new ModelConfigError(`SINCLAIR_AGENT_ACT_PERMISSION=${JSON.stringify(perm)}: allow 또는 deny 여야 함`);
  return { executor, pii: piiFromEnv(env), ...(perm ? { incidents: { permission: perm as 'allow' | 'deny' } } : {}), ...(sp === '1' ? { safetyNet: { pixels: true } } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}
