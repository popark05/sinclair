// Claude 실행기: StepExecutor 뒤에서 Claude API(공식 SDK)가 다음 툴을 고른다.
// 턴마다 상태 없는 요청 하나: 고정 system + action spec 툴(닫힌 strict 스키마) + user 메시지 하나(목표·지난 턴·지금 화면).
// system 과 툴이 매 턴 같아 그 앞부분에 캐시 표시를 둔다. 다만 지금 크기(약 1~1.5천 토큰)는 모델의 최소 캐시 길이에 못 미칠 수 있어
// 실제 적중은 opt-in 실호출의 cacheWriteTokens/cacheReadTokens 로 확인한다(툴·system 이 커지면 저절로 맞는다).
// 키는 SDK 가 환경변수(ANTHROPIC_API_KEY 등)·프로필에서 읽는다. 키는 헤더로만 가고 로그·이벤트·오류 문구에 싣지 않는다.
// 사내망(SSL 인터셉션)은 NODE_EXTRA_CA_CERTS 로 CA 묶음을 주면 Node 의 fetch 가 신뢰한다.
import Anthropic from '@anthropic-ai/sdk';
import type { StepUsage } from '@sinclair/protocol';
import { createHash } from 'node:crypto';
import { renderLedger, renderTurn, blockFoldOf, LEDGER_BLOCK, DEFAULT_LEDGER_BUDGET } from './ledger.ts';
import { addUsage } from './usage.ts';
import { ModelCallError, ModelConfigError, type JudgeReply, type JudgeRequest, type StepExecutor, type StepReply, type StepRequest } from './executor.ts';

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5';
/** 여러 단계 툴 사용의 권장값. 쉬운 화면 조작에 high 는 느리고 비싸다 */
export const DEFAULT_AGENT_EFFORT = 'medium';
/** 한 턴의 출력(적응형 사고 + 툴 호출 하나)에 넉넉하고, 스트리밍 없이 보내도 되는 크기 */
export const DEFAULT_AGENT_MAX_TOKENS = 8192;
/** 요청 하나의 기한. act 전체 기한(기본 120초)이 따로 있다 */
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 60_000;
/** 일시 오류(연결·408·409·429·5xx)만 SDK 가 재시도한다 */
export const DEFAULT_AGENT_MAX_RETRIES = 2;
/** 서버 측 fallback(`fallbacks: "default"`) 의 베타 헤더. 지원하지 않는 모델에서는 요청한 모델만으로 돈다 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface ClaudeExecutorOptions {
  /** 기본 claude-sonnet-5-5. claude-opus-5-5·claude-haiku-5-5 로 바꿀 수 있다 */
  model?: string;
  effort?: AgentEffort;
  maxTokens?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  /** 화면 이미지도 보낸다(비용이 크다. 기본 트리만) */
  pixels?: boolean;
  /** 주지 않으면 SDK 기본 자격 증명(ANTHROPIC_API_KEY·ANTHROPIC_AUTH_TOKEN·프로필) */
  apiKey?: string;
  /** 주지 않으면 ANTHROPIC_BASE_URL 또는 공식 API */
  baseURL?: string;
  /** HTTP 요청에 쓸 fetch(기본 전역 fetch). 실기기 증거 스크립트가 요청 본문을 기록할 때 */
  fetch?: typeof fetch;
  /** Ledger 예산(user 메시지 추정 토큰, 기본 8000) */
  ledgerBudget?: number;
  /** 설정하면 접힌 8턴 묶음을 이 모델이 요약한다(예: claude-haiku-5-5). 없으면 결정적 요약 */
  ledgerSummaryModel?: string;
}

const SUMMARY_SYSTEM = '너는 모바일 앱 테스트 에이전트의 지난 턴 기록을 요약한다. 무엇을 시도했고 화면이 어떻게 바뀌었고 무엇이 실패했는지 한국어 한두 문장으로만 쓴다. 입력 값은 적지 않는다.';

const SYSTEM = [
  '너는 모바일·웹 앱을 조작해 사용자가 준 목표를 이루는 테스트 에이전트다.',
  '매 턴 지금 화면(접근성 트리, 한 줄에 노드 하나: @ref 역할 "이름" 속성 (상태))과 지난 턴의 결과를 받는다.',
  '한 턴에 툴을 정확히 하나 부른다. 대상은 지금 화면에 있는 @ref 로만 고른다(지난 화면의 ref 는 바뀌었을 수 있다).',
  '지난 턴이 rejected·error 면 그 사유를 읽고 다른 대상이나 행동을 고른다. 같은 실패를 되풀이하지 않는다.',
  'Incident(끼어든 창·같은 호출의 연속 실패) 알림이 있으면 그 상황부터 해결한다.',
  '목표를 이뤘음을 지금 화면으로 확인했을 때만 done 을 부르고, summary 에 화면의 근거를 적는다. 이루지 못한 결과를 done 으로 보고하지 않는다(그때는 blocked).',
  'secure 로 표시된 칸의 값은 보이지 않는다. 입력할 값은 목표에 주어진 것만 쓴다.',
  '목표에 {{secret:이름}} 으로 주어진 비밀값(PIN·비밀번호)은 enter_secret 으로 넣는다(키패드 숫자를 직접 탭하지 않는다). 목표에 없는 비밀값이 필요하거나 사람만 할 단계(본인인증 등)를 만나면 값을 지어내지 말고 blocked 를 부른다.',
].join('\n');

const JUDGE_SYSTEM = [
  '너는 모바일·웹 앱 화면을 판정하는 테스트 검사자다. 화면을 조작하지 않는다.',
  '지금 화면(접근성 트리, 한 줄에 노드 하나: @ref 역할 "이름" 속성 (상태))과 질문을 받고, 주어진 JSON 스키마에 맞는 답만 낸다.',
  '판정(assert)은 질문이 지금 화면에서 참인지 pass 로, 화면의 근거를 reason 에 적는다. 화면에서 확인할 수 없으면 거짓이다.',
  '추출(extract)은 찾는 값을 value 에, 값을 읽은 노드의 @ref 를 sourceRefs 에 적는다. 화면에 없으면 found 를 false 로 한다. 짐작으로 값을 지어내지 않는다.',
  'secure 로 표시된 칸의 값은 보이지 않으며 추출 대상이 아니다.',
].join('\n');

const mediaType = (b: Uint8Array): 'image/png' | 'image/jpeg' => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png');

/** API 사용량 → 스텝 사용량. model 은 응답이 밝힌 실제 모델(서버 측 fallback 이면 그 모델) — 모델마다 단가가 달라 내역으로 남긴다 */
function toUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined, model?: string): StepUsage | undefined {
  if (!u) return undefined;
  const tokens = {
    inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
  };
  return model ? { ...tokens, byModel: { [model]: { ...tokens } } } : tokens;
}

const apiMessage = (err: InstanceType<typeof Anthropic.APIError>): string => {
  const m = (err.error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === 'string' && m ? `: ${m.slice(0, 200)}` : '';
};

/** SDK 오류 → 루프가 다루는 오류. 결정적인 문제(자격 증명·요청 모양·없는 모델)는 설정 오류(테스트 탓 아님, blocked), 그 밖은 모델 호출 실패.
 *  응답 본문 전체·키는 싣지 않는다(API 검증 메시지는 파라미터를 말할 뿐 프롬프트 내용을 싣지 않아 200자까지만) */
function translateError(err: unknown, model: string): unknown {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ModelConfigError(`Claude API 가 자격 증명을 거부함(${err.status}): ANTHROPIC_API_KEY 를 확인`);
  }
  if (err instanceof Anthropic.NotFoundError) return new ModelConfigError(`Claude API 404(모델 ${model} 또는 주소): SINCLAIR_AGENT_MODEL·ANTHROPIC_BASE_URL 을 확인${apiMessage(err)}`);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.ContentTooLargeError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ModelConfigError(`Claude API 가 요청을 거부함(${err.status})${apiMessage(err)} — 모델·SINCLAIR_AGENT_MODEL_* 설정을 확인`);
  }
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelCallError(`Claude API 요청 기한 초과(SINCLAIR_AGENT_MODEL_TIMEOUT_MS): ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) {
    // 원인 코드(SELF_SIGNED_CERT_IN_CHAIN·ECONNREFUSED 등)를 실어 CA 문제와 주소 문제를 가른다
    const code = (err.cause as { code?: unknown; cause?: { code?: unknown } } | undefined);
    const why = [code?.code, code?.cause?.code].find((c) => typeof c === 'string');
    return new ModelCallError(`Claude API 에 연결하지 못함(${why ?? err.message}) — 사내망이면 NODE_EXTRA_CA_CERTS 에 CA 묶음을 지정`);
  }
  if (err instanceof Anthropic.APIError) return new ModelCallError(`Claude API 오류 ${err.status ?? ''}${apiMessage(err)}`.trim());
  // 그 밖의 SDK 오류는 자격 증명 사슬(키 없음·없는 프로필·토큰 파일)에서 난다
  if (err instanceof Anthropic.AnthropicError) {
    return new ModelConfigError(`Claude API 자격 증명을 얻지 못함(${err.message.slice(0, 200)}): ANTHROPIC_API_KEY(또는 ANTHROPIC_AUTH_TOKEN·ANTHROPIC_PROFILE)를 설정`);
  }
  if (err instanceof Error && /resolve authentication/i.test(err.message)) {
    return new ModelConfigError('Claude API 자격 증명이 없음: ANTHROPIC_API_KEY(또는 ANTHROPIC_AUTH_TOKEN·ANTHROPIC_PROFILE)를 설정');
  }
  return err;
}

export function createClaudeExecutor(options: ClaudeExecutorOptions = {}): StepExecutor {
  const model = options.model ?? DEFAULT_AGENT_MODEL;
  let client: Anthropic | undefined;
  // 클라이언트는 첫 호출에: agent.act 를 쓰지 않는 테스트는 자격 증명이 없어도 돈다
  const getClient = (): Anthropic => (client ??= new Anthropic({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.requestTimeoutMs ?? DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_AGENT_MAX_RETRIES,
  }));

  const maxTokens = options.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS;
  const imageBlock = (pixels: Uint8Array | undefined): Anthropic.Beta.BetaContentBlockParam[] =>
    (options.pixels && pixels ? [{ type: 'image', source: { type: 'base64', media_type: mediaType(pixels), data: Buffer.from(pixels).toString('base64') } }] : []);

  /** 턴·판정이 함께 쓰는 요청: 고정 system(캐시 표시) + user 메시지 하나, 서버 측 fallback. 거절은 내용보다 먼저 본다(fallback 모델까지 거절한 경우) */
  async function send(signal: AbortSignal, r: { system: string; content: Anthropic.Beta.BetaContentBlockParam[]; extra?: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, 'tools' | 'tool_choice'>; format?: Record<string, unknown> }): Promise<Anthropic.Beta.BetaMessage> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await getClient().beta.messages.create({
        model,
        max_tokens: maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: options.effort ?? DEFAULT_AGENT_EFFORT, ...(r.format ? { format: { type: 'json_schema', schema: r.format } } : {}) },
        system: [{ type: 'text', text: r.system, cache_control: { type: 'ephemeral' } }],
        ...r.extra,
        messages: [{ role: 'user', content: r.content }],
      }, { signal });
    } catch (err) {
      throw translateError(err, model);
    }
    if (res.stop_reason === 'refusal') throw new ModelCallError(`모델이 거절함(${res.stop_details?.category ?? '범주 없음'})`, toUsage(res.usage, res.model));
    return res;
  }

  /** 묶음 내용(목표 + 그 8턴) 해시 → 모델 요약. '' 는 실패(결정적 요약으로, 다시 묻지 않는다).
   *  내용으로 키를 잡아야 같은 실행기를 쓰는 다른 act·다른 목표에 남의 요약이 가지 않는다 */
  const summaries = new Map<string, string>();
  const blockText = (req: StepRequest, from: number): string => req.history.slice(from, from + LEDGER_BLOCK).map((t, i) => renderTurn(t, from + i, 120)).join('\n');
  const blockKey = (req: StepRequest, from: number): string => createHash('sha1').update(req.goal).update('\u0000').update(blockText(req, from)).digest('hex');
  async function prefetchSummaries(req: StepRequest, signal: AbortSignal): Promise<ReturnType<typeof toUsage>> {
    const summaryModel = options.ledgerSummaryModel;
    if (!summaryModel) return undefined;
    let used: ReturnType<typeof toUsage>;
    for (let from = 0; from < blockFoldOf(req.history.length); from += LEDGER_BLOCK) {
      const key = blockKey(req, from);
      if (summaries.has(key)) continue;
      try {
        const r = await getClient().messages.create({ model: summaryModel, max_tokens: 400, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: `목표: ${req.goal}\n\n${blockText(req, from)}` }] }, { signal });
        used = addUsage(used, toUsage(r.usage, r.model));
        const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
        summaries.set(key, r.stop_reason === 'refusal' ? '' : text.slice(0, 400));
      } catch (err) {
        if (signal.aborted) throw err;
        // 자격 증명·모델 이름·요청 모양 문제는 설정 오류(그 변수를 밝혀서). 일시 오류는 결정적 요약으로 넘어가고 턴은 계속
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw translateError(err, summaryModel);
        if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) throw new ModelConfigError(`요약 모델 ${summaryModel} 요청이 거부됨(${err.status}): SINCLAIR_AGENT_LEDGER_SUMMARY_MODEL 을 확인`);
        summaries.set(key, '');
      }
    }
    return used;
  }

  return {
    ...(options.pixels ? { pixels: true } : {}),
    async next(req, signal): Promise<StepReply> {
      const summaryUsage = await prefetchSummaries(req, signal);
      const ledger = renderLedger(req, { budgetTokens: options.ledgerBudget ?? DEFAULT_LEDGER_BUDGET, blockSummary: (from) => summaries.get(blockKey(req, from - 1)) || undefined });
      // 본 요청이 실패해도 요약에 쓴 토큰은 비용으로 남긴다
      const res = await send(signal, {
        system: SYSTEM,
        content: [...imageBlock(req.pixels), { type: 'text', text: ledger.text }],
        // action spec 에서 만든 스키마 그대로 + strict(스키마를 지키는 입력만). 강제 tool_choice 는 Sonnet 5.5 에서 400 이라 auto + 지시
        extra: { tools: req.tools.map((t) => ({ ...t, strict: true })), tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
      }).catch((err: unknown) => {
        if (summaryUsage && err instanceof ModelCallError) throw new ModelCallError(err.message, addUsage(summaryUsage, err.usage));
        if (summaryUsage && !(err instanceof ModelConfigError) && err instanceof Error && !(err instanceof Anthropic.APIUserAbortError)) throw new ModelCallError(err.message, summaryUsage);
        throw err;
      });
      const usage = addUsage(summaryUsage, toUsage(res.usage, res.model));
      const tool = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (tool) return { call: { name: tool.name, input: tool.input }, ...(usage ? { usage } : {}) };
      if (res.stop_reason === 'max_tokens') throw new ModelCallError(`툴을 부르기 전에 max_tokens(${maxTokens})에서 잘림`, usage);
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      return { ...(text ? { text } : {}), ...(usage ? { usage } : {}) };
    },
    // 판정: 툴 없이 구조화 출력(json_schema). 스키마는 판정 동사가 만든 닫힌 스키마(추가 속성 금지)
    async judge(req: JudgeRequest, signal): Promise<JudgeReply> {
      const prompt = [`${req.kind === 'assert' ? '판정할 문장' : '추출할 값'}: ${req.question}`, '', '지금 화면:', req.observation].join('\n');
      const res = await send(signal, { system: JUDGE_SYSTEM, content: [...imageBlock(req.pixels), { type: 'text', text: prompt }], format: req.schema });
      const usage = toUsage(res.usage, res.model);
      if (res.stop_reason === 'max_tokens') throw new ModelCallError(`답을 끝내기 전에 max_tokens(${maxTokens})에서 잘림`, usage);
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      try {
        return { answer: JSON.parse(text) as unknown, ...(usage ? { usage } : {}) };
      } catch {
        throw new ModelCallError('모델 답이 JSON 이 아님', usage);
      }
    },
  };
}

/** 실호출 전 점검: 자격 증명·주소로 Claude API 에 닿는가(토큰 세기 한 번, 과금 없음). 닿지 않으면 'unreachable', 자격 증명 문제는 ModelConfigError */
export async function probeClaude(options: ClaudeExecutorOptions = {}): Promise<'ok' | 'unreachable'> {
  const client = new Anthropic({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}), ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}), timeout: 15_000, maxRetries: 0,
  });
  try {
    await client.messages.countTokens({ model: options.model ?? DEFAULT_AGENT_MODEL, messages: [{ role: 'user', content: 'ping' }] });
    return 'ok';
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionError) return 'unreachable';
    throw translateError(err, options.model ?? DEFAULT_AGENT_MODEL);
  }
}

const ENV = {
  model: 'SINCLAIR_AGENT_MODEL', effort: 'SINCLAIR_AGENT_MODEL_EFFORT', requestTimeoutMs: 'SINCLAIR_AGENT_MODEL_TIMEOUT_MS',
  maxRetries: 'SINCLAIR_AGENT_MODEL_RETRIES', maxTokens: 'SINCLAIR_AGENT_MODEL_MAX_TOKENS', pixels: 'SINCLAIR_AGENT_MODEL_PIXELS',
  ledgerBudget: 'SINCLAIR_AGENT_LEDGER_BUDGET', ledgerSummaryModel: 'SINCLAIR_AGENT_LEDGER_SUMMARY_MODEL',
} as const;

/** 정수 환경변수(비면 미설정). 범위 밖·정수 아님은 변수 이름을 밝힌 설정 오류 */
export function envInt(env: Record<string, string | undefined>, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new ModelConfigError(`${name}=${JSON.stringify(raw)}: ${min}~${max} 정수여야 함`);
  return n;
}

/** 환경변수 → 실행기 설정(키·주소는 SDK 가 직접 읽는다). 잘못된 값은 어느 변수인지 밝힌 설정 오류 */
export function claudeOptionsFromEnv(env: Record<string, string | undefined> = process.env): ClaudeExecutorOptions {
  const out: ClaudeExecutorOptions = {};
  if (env[ENV.model]) out.model = env[ENV.model]!;
  const effort = env[ENV.effort];
  if (effort) {
    if (!(AGENT_EFFORTS as readonly string[]).includes(effort)) throw new ModelConfigError(`${ENV.effort}=${JSON.stringify(effort)}: ${AGENT_EFFORTS.join('|')} 중 하나여야 함`);
    out.effort = effort as AgentEffort;
  }
  const timeout = envInt(env, ENV.requestTimeoutMs, 1000, 600_000);
  if (timeout !== undefined) out.requestTimeoutMs = timeout;
  const retries = envInt(env, ENV.maxRetries, 0, 10);
  if (retries !== undefined) out.maxRetries = retries;
  const tokens = envInt(env, ENV.maxTokens, 256, 64_000);
  if (tokens !== undefined) out.maxTokens = tokens;
  const budget = envInt(env, ENV.ledgerBudget, 1000, 200_000);
  if (budget !== undefined) out.ledgerBudget = budget;
  if (env[ENV.ledgerSummaryModel]) out.ledgerSummaryModel = env[ENV.ledgerSummaryModel]!;
  const pixels = env[ENV.pixels];
  if (pixels) {
    if (pixels !== '1' && pixels !== '0') throw new ModelConfigError(`${ENV.pixels}=${JSON.stringify(pixels)}: 1 또는 0 이어야 함`);
    if (pixels === '1') out.pixels = true;
  }
  return out;
}
