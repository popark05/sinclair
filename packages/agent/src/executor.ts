// StepExecutor 경계: 에이전트 루프는 "목표 + 지금 화면 + 지난 턴 → 다음 툴 호출" 만 묻는다. 모델(Claude, agent-layer 02)이든
// 대본(테스트)이든 이 모양만 지키면 바꿔 끼울 수 있다(e2e 의 교체 가능한 StepExecutor 구조).
import type { ToolCall, ToolSchema } from './action-spec.ts';

/** 지난 턴 하나: 모델이 낸 호출과 그 결과. 거부(rejected)·엔진 오류(error)도 모델이 고칠 수 있게 그대로 돌려준다 */
export interface AgentTurn { call: ToolCall; result: 'ok' | 'rejected' | 'error'; detail?: string }

export interface StepRequest {
  goal: string;
  /** renderObservation 결과(secure 값 없음) */
  observation: string;
  history: readonly AgentTurn[];
  tools: readonly ToolSchema[];
}

export interface StepExecutor {
  next(request: StepRequest, signal: AbortSignal): Promise<ToolCall>;
}

/** 테스트용 실행기: 대본(호출 배열 — 다 쓰면 실패) 또는 함수. 받은 요청을 requests 에 남겨 무엇이 모델에 갔는지 검사할 수 있다 */
export interface ScriptedExecutor extends StepExecutor { readonly requests: StepRequest[] }

export function scriptedExecutor(script: readonly ToolCall[] | ((request: StepRequest, index: number) => ToolCall | Promise<ToolCall>)): ScriptedExecutor {
  const requests: StepRequest[] = [];
  return {
    requests,
    async next(request) {
      requests.push(structuredClone(request));
      const i = requests.length - 1;
      if (typeof script === 'function') return script(request, i);
      const call = script[i];
      if (!call) throw new Error(`대본이 ${script.length}턴에서 끝남`);
      return call;
    },
  };
}
