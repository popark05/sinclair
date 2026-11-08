// agent.act 툴 루프: 매 턴 화면을 관찰해 실행기(모델)에 다음 툴을 묻고, 닫힌 검사를 통과한 호출만 엔진에 실행한다.
// 잘못된 호출(검사 실패)과 엔진 오류는 실행하지 않거나 실패한 채로 다음 턴의 기록에 실어 모델이 고치게 하고, 턴 한도에 센다.
// done 이면 성공, 턴·시간 한도에 닿거나 실행기가 던지면 실패(사유).
import { EngineError, type Engine, type EngineErrorCode, type StepUsage } from '@sinclair/protocol';
import { ACTIONS, checkToolCall, toolSchemas, type ActionSpec } from './action-spec.ts';
import { ModelConfigError, ModelCallError, type AgentTurn, type StepExecutor, type StepReply } from './executor.ts';
import { renderObservation } from './observe.ts';
import { addUsage } from './usage.ts';

/** 기본 턴 한도: 로그인·화면 이동 같은 목표는 대개 10턴 안에 끝난다. 20 이면 헤매는 모델을 멈추면서 정상 목표는 넉넉하다 */
export const DEFAULT_MAX_TURNS = 20;
/** 기본 시간 한도: 모델 호출 한 번이 수 초라 20턴 × ~5초 ≈ 100초에 여유를 둔다 */
export const DEFAULT_ACT_TIMEOUT_MS = 120_000;

/** 모델이 고칠 수 있는 엔진 오류: 다음 턴에 알려 다른 대상·행동을 고르게 한다. 그 밖(기기 없음·기기 오류 등)은 인프라 문제라 act 를 그 코드로 끝낸다 —
 *  턴을 태우다 agent 실패로 뭉개지 않게(Verdict 에서 blocked 로 보여야 한다) */
const CORRECTABLE: ReadonlySet<EngineErrorCode> = new Set(['not-found', 'not-actionable', 'unsupported-action', 'ambiguous']);
/** 모델에 돌려줄 오류 문구 상한 */
const MAX_DETAIL = 300;

/** 오류 문구에서 이번 호출이 입력한 글자를 지운다: 실기기 셸 오류는 입력 명령(글자 포함)을 그대로 싣는다 — 비밀값이 모델에 되돌아가지 않게 */
function scrubDetail(detail: string, input: Record<string, string>): string {
  let out = detail;
  if (input.text) out = out.split(input.text).join('<입력값>');
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL)}…` : out;
}

/** promise 와 abort 의 경주. 이미 abort 됐으면 바로 거부하고, 끝나면 리스너를 뗀다(턴마다 쌓이지 않게) */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason as Error); signal.addEventListener('abort', onAbort, { once: true }); });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

export interface ActOptions { executor: StepExecutor; maxTurns?: number; timeoutMs?: number }
export interface ActResult {
  ok: boolean;
  turns: number;
  /** 실행기(모델)에 물은 횟수 */
  modelCalls: number;
  /** 모델 토큰 사용량 합. 사용량을 보고하지 않는 실행기(대본)면 없다 */
  usage?: StepUsage;
  /** 성공 시 모델이 done 에 쓴 근거 */
  summary?: string;
  /** 실패 사유 */
  reason?: string;
  history: AgentTurn[];
}

/** act 가 던질 때 그때까지 쓴 모델 호출 수·토큰. 오류 객체를 바꾸지 않고 옆에 둔다(러너가 실패 스텝에 싣는다) */
export interface ActProgress { modelCalls: number; usage?: StepUsage }
const progress = new WeakMap<object, ActProgress>();
export function actProgressOf(err: unknown): ActProgress | undefined {
  return typeof err === 'object' && err !== null ? progress.get(err) : undefined;
}

/** 모델이 고칠 수 없는 엔진 오류(기기 없음 등)와 관찰 실패는 EngineError 로 던진다 — 결과로 돌려주지 않는다. 던진 오류의 진행은 actProgressOf 로 읽는다 */
export async function runAct(engine: Engine, goal: string, opts: ActOptions): Promise<ActResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(new Error(`시간 한도 ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const history: AgentTurn[] = [];
  let modelCalls = 0;
  let usage: StepUsage | undefined;
  const result = (r: Pick<ActResult, 'ok' | 'summary' | 'reason'>): ActResult => ({ ...r, turns: history.length, modelCalls, ...(usage ? { usage } : {}), history });
  const fail = (reason: string): ActResult => result({ ok: false, reason });
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() >= deadline) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
      const observed = await engine.observe(opts.executor.pixels ? { pixels: true } : undefined);
      const observation = renderObservation(observed.root);
      // 관찰하는 사이 한도가 지났으면 묻지 않는다(abort 가 리스너보다 먼저 와서 영영 기다리는 일이 없게 raceAbort 도 같은 검사를 한다)
      if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
      let reply: StepReply;
      try {
        modelCalls++;
        // 실행기가 시간 한도를 넘기면 기다리지 않는다. 스키마는 매번 새로(실행기가 고쳐도 다음 턴에 영향 없게)
        const request = { goal, observation, history: history.map((h) => ({ ...h })), tools: toolSchemas(), ...(opts.executor.pixels && observed.pixels ? { pixels: observed.pixels } : {}) };
        reply = await raceAbort(opts.executor.next(request, aborter.signal), aborter.signal);
      } catch (err) {
        if (err instanceof ModelConfigError) throw err; // 설정 문제는 테스트 실패가 아니다: 러너가 blocked 로 다룬다
        if (err instanceof ModelCallError) usage = addUsage(usage, err.usage);
        if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`모델 호출 실패: ${msg.length > MAX_DETAIL ? `${msg.slice(0, MAX_DETAIL)}…` : msg}`);
      }
      usage = addUsage(usage, reply.usage);
      const call = reply.call;
      if (!call) {
        const said = reply.text?.trim() ? `: ${reply.text.trim().slice(0, MAX_DETAIL)}` : '';
        history.push({ result: 'rejected', detail: `툴을 부르지 않음 — 한 턴에 툴 하나를 불러야 함${said}` });
        continue;
      }
      const checked = checkToolCall(call);
      if (!checked.ok) { history.push({ call, result: 'rejected', detail: checked.error }); continue; }
      const spec: ActionSpec = ACTIONS[checked.call.name];
      try {
        await spec.run(engine, checked.call.input);
      } catch (err) {
        // 인프라 오류는 모델이 고칠 수 없다: 그 코드 그대로 던져 러너가 blocked 등으로 다루게 한다
        if (err instanceof EngineError && !CORRECTABLE.has(err.code)) throw err;
        const raw = err instanceof EngineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        history.push({ call, result: 'error', detail: scrubDetail(raw, checked.call.input) });
        continue;
      }
      history.push({ call, result: 'ok' });
      if (spec.terminal) return result({ ok: true, ...(checked.call.input.summary ? { summary: checked.call.input.summary } : {}) });
    }
    return fail(`턴 한도 ${maxTurns} 안에 목표를 이루지 못함`);
  } catch (err) {
    if (typeof err === 'object' && err !== null) progress.set(err, { modelCalls, ...(usage ? { usage } : {}) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
