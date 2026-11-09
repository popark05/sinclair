// StepExecutor 경계: 에이전트 루프는 "목표 + 지금 화면 + 지난 턴 → 다음 툴 호출" 만 묻는다. 모델(Claude)이든
// 대본(테스트)이든 이 모양만 지키면 바꿔 끼울 수 있다(e2e 의 교체 가능한 StepExecutor 구조).
import type { StepUsage } from '@sinclair/protocol';
import type { ToolCall, ToolSchema } from './action-spec.ts';

/** 지난 턴 하나: 모델이 낸 호출과 그 결과. 거부(rejected)·엔진 오류(error)도 모델이 고칠 수 있게 그대로 돌려준다. 툴을 부르지 않은 턴은 call 이 없다 */
export interface AgentTurn {
  call?: ToolCall; result: 'ok' | 'rejected' | 'error'; detail?: string;
  /** 안전망이 실행 직전에 다시 찾아 실제로 실행한 ref(모델이 고른 ref 와 다를 때) */
  retargeted?: string;
  /** 안전망이 실행을 막은 이유: 대상이 사라짐·애매함·영역이 덮임 */
  guard?: 'gone' | 'ambiguous' | 'covered';
  /** 이 턴 뒤 화면이 바뀐 부분(Ledger 가 이전 관찰 대신 싣는다) */
  change?: string;
}

export interface StepRequest {
  goal: string;
  /** renderObservation 결과(secure 값 없음) */
  observation: string;
  history: readonly AgentTurn[];
  tools: readonly ToolSchema[];
  /** 화면 이미지(PNG/JPEG). 실행기가 pixels 를 원할 때만 */
  pixels?: Uint8Array;
  /** 자동 복구하지 못한 Incident(끼어든 창·연속 실패). 이번 턴에 먼저 해결하라는 알림 */
  incident?: string;
}

/** 실행기의 답: 툴 호출 하나, 또는 툴 없이 낸 글(거부로 기록돼 다음 턴에 다시 묻는다). usage 는 이 턴의 토큰(모르면 생략) */
export interface StepReply { call?: ToolCall; text?: string; usage?: StepUsage }

/** 판정 요청: 화면을 바꾸지 않는 질문 하나. 모델은 schema(닫힌 JSON 스키마)에 맞는 답만 낸다 */
export interface JudgeRequest {
  kind: 'assert' | 'extract';
  question: string;
  /** renderObservation 결과(secure 값 없음) */
  observation: string;
  schema: Record<string, unknown>;
  pixels?: Uint8Array;
}
export interface JudgeReply { answer: unknown; usage?: StepUsage }

export interface StepExecutor {
  /** true 면 루프가 화면 이미지도 함께 관찰해 요청에 싣는다(비용이 크다. 기본 트리만) */
  readonly pixels?: boolean;
  next(request: StepRequest, signal: AbortSignal): Promise<StepReply>;
  /** 판정 동사(assert·waitFor·extract)용. 툴 없이 구조화 답만. 없으면 판정 동사는 설정 오류 */
  judge?(request: JudgeRequest, signal: AbortSignal): Promise<JudgeReply>;
}

/** 실행기 설정 문제(키 없음·잘못된 키·잘못된 설정값). 테스트 탓이 아니므로 루프는 실패 결과로 뭉개지 않고 그대로 던진다 */
export class ModelConfigError extends Error {
  override name = 'ModelConfigError';
}

/** 모델 호출이 답을 못 냄(거절·잘림 등). 그 호출이 쓴 토큰을 실어 비용 집계에서 빠지지 않게 한다 */
export class ModelCallError extends Error {
  override name = 'ModelCallError';
  constructor(message: string, readonly usage?: StepUsage) { super(message); }
}

/** 테스트용 실행기: 대본(호출·답 배열 — 다 쓰면 실패) 또는 함수. 받은 요청을 requests 에 남겨 무엇이 모델에 갔는지 검사할 수 있다 */
export interface ScriptedExecutor extends StepExecutor { readonly requests: StepRequest[] }

type ScriptItem = ToolCall | StepReply;
const toReply = (item: ScriptItem): StepReply => ('name' in item ? { call: item } : item);

export function scriptedExecutor(script: readonly ScriptItem[] | ((request: StepRequest, index: number) => ScriptItem | Promise<ScriptItem>)): ScriptedExecutor {
  const requests: StepRequest[] = [];
  return {
    requests,
    async next(request) {
      requests.push(structuredClone(request));
      const i = requests.length - 1;
      if (typeof script === 'function') return toReply(await script(request, i));
      const item = script[i];
      if (!item) throw new Error(`대본이 ${script.length}턴에서 끝남`);
      return toReply(item);
    },
  };
}
