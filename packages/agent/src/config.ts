// 환경변수 → agent.act 설정 한 벌(실행기 + 한도). runner-agent 가 runTests 의 agent 옵션으로 넘긴다.
// 실행기 설정은 claudeOptionsFromEnv, act 한도는 SINCLAIR_AGENT_ACT_MAX_TURNS·SINCLAIR_AGENT_ACT_TIMEOUT_MS. 잘못된 값은 ModelConfigError
import { claudeOptionsFromEnv, createClaudeExecutor, envInt } from './claude.ts';
import type { StepExecutor } from './executor.ts';

export interface AgentSetup { executor: StepExecutor; maxTurns?: number; timeoutMs?: number }

export function agentFromEnv(env: Record<string, string | undefined> = process.env): AgentSetup {
  const executor = createClaudeExecutor(claudeOptionsFromEnv(env));
  const maxTurns = envInt(env, 'SINCLAIR_AGENT_ACT_MAX_TURNS', 1, 200);
  const timeoutMs = envInt(env, 'SINCLAIR_AGENT_ACT_TIMEOUT_MS', 1000, 3_600_000);
  return { executor, ...(maxTurns !== undefined ? { maxTurns } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}
