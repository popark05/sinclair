// 환경변수 → agent.act 설정 한 벌(실행기 + 한도). runner-agent 가 runTests 의 agent 옵션으로 넘긴다.
// 실행기 설정은 claudeOptionsFromEnv, act 한도는 SINCLAIR_AGENT_ACT_MAX_TURNS·SINCLAIR_AGENT_ACT_TIMEOUT_MS. 잘못된 값은 ModelConfigError
import { claudeOptionsFromEnv, createClaudeExecutor } from './claude.ts';
import { ModelConfigError, type StepExecutor } from './executor.ts';

export interface AgentSetup { executor: StepExecutor; maxTurns?: number; timeoutMs?: number }

function int(env: Record<string, string | undefined>, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ModelConfigError(`${name}=${JSON.stringify(raw)}: ${min}~${max} 정수여야 함`);
  return Number(raw);
}

export function agentFromEnv(env: Record<string, string | undefined> = process.env): AgentSetup {
  const executor = createClaudeExecutor(claudeOptionsFromEnv(env));
  const maxTurns = int(env, 'SINCLAIR_AGENT_ACT_MAX_TURNS', 1, 200);
  const timeoutMs = int(env, 'SINCLAIR_AGENT_ACT_TIMEOUT_MS', 1000, 3_600_000);
  return { executor, ...(maxTurns !== undefined ? { maxTurns } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}
