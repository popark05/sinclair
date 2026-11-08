// 판정 동사: assert(참/거짓)·waitFor(참이 될 때까지)·extract(지정한 타입의 값). 화면을 바꾸지 않는다 — 엔진은 관찰만, 모델에는 툴을 주지 않는다.
// 모델은 닫힌 답 스키마로만 답하고, 에이전트가 같은 스키마로 다시 검사한다(구조화 출력을 믿되 확인한다).
import { EngineError, type Engine, type SemanticNode, type StepUsage } from '@sinclair/protocol';
import { ModelCallError, ModelConfigError, type JudgeRequest, type StepExecutor } from './executor.ts';
import { createHash } from 'node:crypto';
import { raceAbort, recordProgress } from './loop.ts';
import { renderObservation } from './observe.ts';
import { addUsage } from './usage.ts';

/** assert·extract 한 번의 기한: 모델 호출 하나(재시도 포함)에 넉넉하게 */
export const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
/** waitFor 기본 기한: 결제·로그인 같은 서버 왕복을 기다리되, 안 오는 화면에 테스트를 오래 묶지 않는다 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** waitFor 재관찰 간격: 관찰은 싸고(트리), 모델은 화면이 바뀔 때만 부르므로 1초면 반응이 빠르면서 기기를 괴롭히지 않는다 */
export const DEFAULT_WAIT_INTERVAL_MS = 1_000;

export type ExtractScalar = 'string' | 'number' | 'boolean';
export type ExtractType = ExtractScalar | { readonly [key: string]: ExtractScalar };
export type ExtractValue<T extends ExtractType> = T extends 'string' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean
  : { -readonly [K in keyof T]: T[K] extends 'string' ? string : T[K] extends 'number' ? number : boolean };

/** false: 판정이 거짓, timeout: waitFor 기한 안에 참이 안 됨, not-found: 추출 대상이 화면에 없음,
 *  invalid: 모델이 계약을 어긴 답·호출 실패·assert/extract 의 기한 초과(모델 한 번이 멈춘 것이지 화면 탓이 아니다) */
export type JudgeFailure = 'false' | 'timeout' | 'not-found' | 'invalid';
export interface JudgeResult<V = unknown> {
  ok: boolean;
  reason: string;
  failure?: JudgeFailure;
  value?: V;
  /** extract 성공 시 값을 읽은 노드(스텝 기록용 — 값 대신 남긴다) */
  sourceRefs?: string[];
  modelCalls: number;
  usage?: StepUsage;
}
export interface JudgeOptions { executor: StepExecutor; timeoutMs?: number }
export interface WaitOptions extends JudgeOptions { intervalMs?: number }

type Schema = Record<string, unknown>;
const ASSERT_SCHEMA: Schema = {
  type: 'object', additionalProperties: false, required: ['pass', 'reason'],
  properties: { pass: { type: 'boolean', description: '질문이 지금 화면에서 참인가' }, reason: { type: 'string', description: '화면의 근거' } },
};
function extractSchema(type: ExtractType): Schema {
  if (typeof type !== 'string') {
    const keys = Object.keys(type);
    if (keys.length === 0 || keys.some((k) => k === '' || k === '__proto__')) throw new Error('extract 타입 객체에는 빈 키·__proto__ 가 아닌 키가 하나 이상 있어야 함');
    for (const [k, t] of Object.entries(type)) if (t !== 'string' && t !== 'number' && t !== 'boolean') throw new Error(`extract 타입 ${k}: string|number|boolean 이어야 함`);
  }
  const value: Schema = typeof type === 'string' ? { type } : { type: 'object', additionalProperties: false, required: Object.keys(type), properties: Object.fromEntries(Object.entries(type).map(([k, t]) => [k, { type: t }])) };
  return {
    type: 'object', additionalProperties: false, required: ['found', 'value', 'sourceRefs', 'reason'],
    properties: {
      found: { type: 'boolean', description: '찾는 값이 지금 화면에 있는가' },
      value: { ...value, description: '찾은 값(found 가 false 면 아무 값)' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: '값을 읽은 노드의 @ref' },
      reason: { type: 'string', description: '화면의 근거' },
    },
  };
}

/** 이 모듈이 만드는 스키마 부분집합(object·string·number·boolean·array<string>)만 검사한다. 어긋난 첫 경로를 돌려준다 */
function mismatch(v: unknown, s: Schema, at = '답'): string | undefined {
  switch (s.type) {
    case 'string': return typeof v === 'string' ? undefined : `${at} 는 문자열이어야 함`;
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? undefined : `${at} 는 숫자여야 함`;
    case 'boolean': return typeof v === 'boolean' ? undefined : `${at} 는 불리언이어야 함`;
    case 'array': {
      if (!Array.isArray(v)) return `${at} 는 배열이어야 함`;
      for (const [i, x] of v.entries()) { const m = mismatch(x, s.items as Schema, `${at}[${i}]`); if (m) return m; }
      return undefined;
    }
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${at} 는 객체여야 함`;
      const props = s.properties as Record<string, Schema>;
      for (const k of Object.keys(v)) if (!Object.hasOwn(props, k)) return `${at}.${k}: 모르는 키`;
      for (const k of s.required as string[]) if (!Object.hasOwn(v, k)) return `${at}.${k}: 빠짐`;
      for (const [k, ps] of Object.entries(props)) { if (Object.hasOwn(v, k)) { const m = mismatch((v as Record<string, unknown>)[k], ps, `${at}.${k}`); if (m) return m; } }
      return undefined;
    }
    default: return `${at}: 알 수 없는 스키마`;
  }
}

function refsOf(root: SemanticNode, out = new Map<string, SemanticNode>()): Map<string, SemanticNode> {
  out.set(root.ref, root);
  for (const c of root.children ?? []) refsOf(c, out);
  return out;
}

/** 판정 한 번: 관찰 → judge → 스키마 검사. 기한은 signal 로 */
class Asker {
  modelCalls = 0;
  usage: StepUsage | undefined;
  constructor(private readonly engine: Engine, private readonly executor: StepExecutor) {
    if (!executor.judge) throw new ModelConfigError('판정 동사(agent.assert·waitFor·extract)를 쓰려면 실행기에 judge 가 필요함');
  }
  async observe() {
    const observed = await this.engine.observe(this.executor.pixels ? { pixels: true } : undefined);
    return { observed, text: renderObservation(observed.root) };
  }
  /** 답이 스키마에 맞으면 answer, 아니면 invalid 사유. 호출 실패(거절 등)도 invalid 사유로 */
  /** 실행 도중 던진 오류에 진행(호출 수·토큰)을 붙여 러너가 실패 스텝에도 비용을 남기게 한다 */
  mark(err: unknown): unknown { recordProgress(err, { modelCalls: this.modelCalls, ...(this.usage ? { usage: this.usage } : {}) }); return err; }
  async ask(kind: JudgeRequest['kind'], question: string, schema: Schema, obs: Awaited<ReturnType<Asker['observe']>>, signal: AbortSignal): Promise<{ answer: Record<string, unknown> } | { invalid: string }> {
    if (signal.aborted) throw signal.reason as Error; // 기한이 지났으면 부르지 않는다(호출 수도 세지 않는다)
    this.modelCalls++;
    const req: JudgeRequest = { kind, question, observation: obs.text, schema: structuredClone(schema), ...(this.executor.pixels && obs.observed.pixels ? { pixels: obs.observed.pixels } : {}) };
    try {
      const reply = await raceAbort(this.executor.judge!(req, signal), signal);
      this.usage = addUsage(this.usage, reply.usage);
      const m = mismatch(reply.answer, schema);
      return m ? { invalid: `모델 답이 스키마와 다름: ${m}` } : { answer: reply.answer as Record<string, unknown> };
    } catch (err) {
      if (err instanceof ModelConfigError || signal.aborted) throw err;
      if (err instanceof ModelCallError) this.usage = addUsage(this.usage, err.usage);
      return { invalid: `모델 호출 실패: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
    }
  }
  result<V>(r: { ok: boolean; reason: string; failure?: JudgeFailure; value?: V; sourceRefs?: string[] }): JudgeResult<V> {
    return { ...r, modelCalls: this.modelCalls, ...(this.usage ? { usage: this.usage } : {}) };
  }
}

function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error(`기한 ${ms}ms`)), ms);
  t.unref?.();
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

export async function judgeAssert(engine: Engine, question: string, opts: JudgeOptions): Promise<JudgeResult> {
  const asker = new Asker(engine, opts.executor);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const d = deadline(timeoutMs);
  try {
    const a = await asker.ask('assert', question, ASSERT_SCHEMA, await asker.observe(), d.signal);
    if ('invalid' in a) return asker.result({ ok: false, failure: 'invalid', reason: a.invalid });
    return asker.result({ ok: a.answer.pass === true, reason: a.answer.reason as string, ...(a.answer.pass ? {} : { failure: 'false' as const }) });
  } catch (err) {
    if (d.signal.aborted) return asker.result({ ok: false, failure: 'invalid', reason: `판정 기한 ${timeoutMs}ms 에 닿음(모델이 답하지 않음)` });
    throw asker.mark(err);
  } finally { d.clear(); }
}

export async function judgeWaitFor(engine: Engine, question: string, opts: WaitOptions): Promise<JudgeResult> {
  const asker = new Asker(engine, opts.executor);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const d = deadline(timeoutMs);
  let lastAsked: string | undefined;
  let lastReason = '아직 묻지 못함';
  const timedOut = () => asker.result({ ok: false, failure: 'timeout' as const, reason: `기한 ${timeoutMs}ms 안에 참이 되지 않음 — 마지막 판정: ${lastReason}` });
  try {
    while (!d.signal.aborted) {
      const obs = await asker.observe();
      if (d.signal.aborted) break;
      // 화면이 지난번에 거짓으로 판정한 그대로면 모델을 다시 부르지 않는다(같은 질문, 같은 화면 → 같은 답이라 비용만 든다)
      // 모델이 보는 것 전부로 비교한다: 트리 + 위치, 이미지를 보는 실행기면 이미지 해시까지(트리는 같고 픽셀만 바뀌는 화면이 있다)
      const seen = [obs.text, obs.observed.location ?? '', opts.executor.pixels && obs.observed.pixels ? createHash('sha1').update(obs.observed.pixels).digest('hex') : ''].join('\u0000');
      if (seen !== lastAsked) {
        const a = await asker.ask('assert', question, ASSERT_SCHEMA, obs, d.signal);
        if ('invalid' in a) return asker.result({ ok: false, failure: 'invalid', reason: a.invalid });
        if (a.answer.pass === true) return asker.result({ ok: true, reason: a.answer.reason as string });
        lastAsked = seen;
        lastReason = a.answer.reason as string;
      }
      let timer: NodeJS.Timeout | undefined;
      await raceAbort(new Promise((r) => { timer = setTimeout(r, intervalMs); }), d.signal).catch(() => {});
      clearTimeout(timer); // 기한으로 끝났으면 남은 간격 타이머가 이벤트 루프를 붙잡지 않게
    }
    return timedOut();
  } catch (err) {
    if (d.signal.aborted) return timedOut();
    throw asker.mark(err);
  } finally { d.clear(); }
}

/** 근거 ref 가 secure 노드면 EngineError('secure-read') 로 던진다(러너의 secure 읽기 규칙과 같다) */
export async function judgeExtract<T extends ExtractType>(engine: Engine, what: string, type: T, opts: JudgeOptions): Promise<JudgeResult<ExtractValue<T>>> {
  const asker = new Asker(engine, opts.executor);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const d = deadline(timeoutMs);
  try {
    const obs = await asker.observe();
    const a = await asker.ask('extract', what, extractSchema(type), obs, d.signal);
    if ('invalid' in a) return asker.result({ ok: false, failure: 'invalid', reason: a.invalid });
    const { found, value, sourceRefs, reason } = a.answer as { found: boolean; value: unknown; sourceRefs: string[]; reason: string };
    if (!found) return asker.result({ ok: false, failure: 'not-found', reason });
    if (sourceRefs.length === 0) return asker.result({ ok: false, failure: 'invalid', reason: '근거 노드(sourceRefs)가 비어 있음' });
    const nodes = refsOf(obs.observed.root);
    const unknown = sourceRefs.filter((r) => !nodes.has(r));
    if (unknown.length) return asker.result({ ok: false, failure: 'invalid', reason: `근거 노드가 화면에 없음: ${unknown.slice(0, 5).join(', ')}` });
    const secure = sourceRefs.find((r) => nodes.get(r)!.states?.secure);
    if (secure) throw new EngineError('secure-read', `${secure} 는 secure 노드라 내용을 추출할 수 없음`, { ref: secure });
    return asker.result({ ok: true, reason, value: value as ExtractValue<T>, sourceRefs });
  } catch (err) {
    if (d.signal.aborted) return asker.result({ ok: false, failure: 'invalid', reason: `추출 기한 ${timeoutMs}ms 에 닿음(모델이 답하지 않음)` });
    throw asker.mark(err);
  } finally { d.clear(); }
}
