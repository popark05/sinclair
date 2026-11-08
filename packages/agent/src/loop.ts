// agent.act 툴 루프: 매 턴 화면을 관찰해 실행기(모델)에 다음 툴을 묻고, 닫힌 검사를 통과한 호출만 엔진에 실행한다.
// 잘못된 호출(검사 실패)과 엔진 오류는 실행하지 않거나 실패한 채로 다음 턴의 기록에 실어 모델이 고치게 하고, 턴 한도에 센다.
// done 이면 성공, 턴·시간 한도에 닿거나 실행기가 던지면 실패(사유).
import { EngineError, type Engine } from '@sinclair/protocol';
import { ACTIONS, checkToolCall, toolSchemas, type ActionSpec } from './action-spec.ts';
import type { AgentTurn, StepExecutor } from './executor.ts';
import { renderObservation } from './observe.ts';

/** 기본 턴 한도: 로그인·화면 이동 같은 목표는 대개 10턴 안에 끝난다. 20 이면 헤매는 모델을 멈추면서 정상 목표는 넉넉하다 */
export const DEFAULT_MAX_TURNS = 20;
/** 기본 시간 한도: 모델 호출 한 번이 수 초라 20턴 × ~5초 ≈ 100초에 여유를 둔다 */
export const DEFAULT_ACT_TIMEOUT_MS = 120_000;

export interface ActOptions { executor: StepExecutor; maxTurns?: number; timeoutMs?: number }
export interface ActResult {
  ok: boolean;
  turns: number;
  /** 실행기(모델)에 물은 횟수 */
  modelCalls: number;
  /** 성공 시 모델이 done 에 쓴 근거 */
  summary?: string;
  /** 실패 사유 */
  reason?: string;
  history: AgentTurn[];
}

export async function runAct(engine: Engine, goal: string, opts: ActOptions): Promise<ActResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(new Error(`시간 한도 ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const history: AgentTurn[] = [];
  const tools = toolSchemas();
  let modelCalls = 0;
  const fail = (reason: string): ActResult => ({ ok: false, turns: history.length, modelCalls, reason, history });
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() >= deadline) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
      const observation = renderObservation((await engine.observe()).root);
      let call;
      try {
        modelCalls++;
        // 실행기가 시간 한도를 넘기면 기다리지 않는다
        call = await Promise.race([
          opts.executor.next({ goal, observation, history: history.map((h) => ({ ...h })), tools }, aborter.signal),
          new Promise<never>((_, reject) => aborter.signal.addEventListener('abort', () => reject(aborter.signal.reason as Error), { once: true })),
        ]);
      } catch (err) {
        if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
        return fail(`모델 호출 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
      const checked = checkToolCall(call);
      if (!checked.ok) { history.push({ call, result: 'rejected', detail: checked.error }); continue; }
      const spec: ActionSpec = ACTIONS[checked.call.name];
      try {
        await spec.run(engine, checked.call.input);
      } catch (err) {
        const detail = err instanceof EngineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        history.push({ call, result: 'error', detail });
        continue;
      }
      history.push({ call, result: 'ok' });
      if (spec.terminal) return { ok: true, turns: history.length, modelCalls, ...(checked.call.input.summary ? { summary: checked.call.input.summary } : {}), history };
    }
    return fail(`턴 한도 ${maxTurns} 안에 목표를 이루지 못함`);
  } finally {
    clearTimeout(timer);
  }
}
