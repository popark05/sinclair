// Claude 실행기: StepExecutor 뒤에서 Claude API(공식 SDK)가 다음 툴을 고른다.
// 턴마다 상태 없는 요청 하나: 고정 system + action spec 툴(닫힌 strict 스키마) + user 메시지 하나(목표·지난 턴·지금 화면).
// system 과 툴이 매 턴 같아 그 앞부분에 캐시 표시를 둔다. 다만 지금 크기(약 1~1.5천 토큰)는 모델의 최소 캐시 길이에 못 미칠 수 있어
// 실제 적중은 opt-in 실호출의 cacheWriteTokens/cacheReadTokens 로 확인한다(툴·system 이 커지면 저절로 맞는다).
// 키는 SDK 가 환경변수(ANTHROPIC_API_KEY 등)·프로필에서 읽는다. 키는 헤더로만 가고 로그·이벤트·오류 문구에 싣지 않는다.
// 사내망(SSL 인터셉션)은 NODE_EXTRA_CA_CERTS 로 CA 묶음을 주면 Node 의 fetch 가 신뢰한다.
import Anthropic from '@anthropic-ai/sdk';
import type { StepUsage } from '@sinclair/protocol';
import { ModelCallError, ModelConfigError, type AgentTurn, type JudgeReply, type JudgeRequest, type StepExecutor, type StepReply, type StepRequest } from './executor.ts';

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
}

const SYSTEM = [
  '너는 모바일·웹 앱을 조작해 사용자가 준 목표를 이루는 테스트 에이전트다.',
  '매 턴 지금 화면(접근성 트리, 한 줄에 노드 하나: @ref 역할 "이름" 속성 (상태))과 지난 턴의 결과를 받는다.',
  '한 턴에 툴을 정확히 하나 부른다. 대상은 지금 화면에 있는 @ref 로만 고른다(지난 화면의 ref 는 바뀌었을 수 있다).',
  '지난 턴이 rejected·error 면 그 사유를 읽고 다른 대상이나 행동을 고른다. 같은 실패를 되풀이하지 않는다.',
  '목표를 이뤘음을 지금 화면으로 확인했을 때만 done 을 부르고, summary 에 화면의 근거를 적는다.',
  'secure 로 표시된 칸의 값은 보이지 않는다. 입력할 값은 목표에 주어진 것만 쓴다.',
].join('\n');

const JUDGE_SYSTEM = [
  '너는 모바일·웹 앱 화면을 판정하는 테스트 검사자다. 화면을 조작하지 않는다.',
  '지금 화면(접근성 트리, 한 줄에 노드 하나: @ref 역할 "이름" 속성 (상태))과 질문을 받고, 주어진 JSON 스키마에 맞는 답만 낸다.',
  '판정(assert)은 질문이 지금 화면에서 참인지 pass 로, 화면의 근거를 reason 에 적는다. 화면에서 확인할 수 없으면 거짓이다.',
  '추출(extract)은 찾는 값을 value 에, 값을 읽은 노드의 @ref 를 sourceRefs 에 적는다. 화면에 없으면 found 를 false 로 한다. 짐작으로 값을 지어내지 않는다.',
  'secure 로 표시된 칸의 값은 보이지 않으며 추출 대상이 아니다.',
].join('\n');

/** 지난 턴 한 줄. type 의 글자는 가린다(비밀번호일 수 있다 — 모델이 쓴 값이라도 되돌려 보내지 않는다) */
function renderTurn(turn: AgentTurn, i: number): string {
  const c = turn.call;
  let what = '(툴 호출 없음)';
  if (c) {
    const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>;
    const parts = Object.entries(input).map(([k, v]) => (k === 'ref' ? String(v) : k === 'text' ? `text=<입력함 ${typeof v === 'string' ? v.length : 0}자>` : `${k}=${JSON.stringify(v)}`));
    what = [c.name, ...parts].join(' ');
  }
  return `${i + 1}. ${what} → ${turn.result}${turn.detail ? `: ${turn.detail}` : ''}`;
}

function renderPrompt(req: StepRequest): string {
  return [
    `목표: ${req.goal}`,
    '',
    '지난 턴:',
    req.history.length ? req.history.map(renderTurn).join('\n') : '(없음)',
    '',
    '지금 화면:',
    req.observation,
    '',
    '다음 툴 하나를 불러라.',
  ].join('\n');
}

const mediaType = (b: Uint8Array): 'image/png' | 'image/jpeg' => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png');

function toUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): StepUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
  };
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
    if (res.stop_reason === 'refusal') throw new ModelCallError(`모델이 거절함(${res.stop_details?.category ?? '범주 없음'})`, toUsage(res.usage));
    return res;
  }

  return {
    ...(options.pixels ? { pixels: true } : {}),
    async next(req, signal): Promise<StepReply> {
      const res = await send(signal, {
        system: SYSTEM,
        content: [...imageBlock(req.pixels), { type: 'text', text: renderPrompt(req) }],
        // action spec 에서 만든 스키마 그대로 + strict(스키마를 지키는 입력만). 강제 tool_choice 는 Sonnet 5.5 에서 400 이라 auto + 지시
        extra: { tools: req.tools.map((t) => ({ ...t, strict: true })), tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
      });
      const usage = toUsage(res.usage);
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
      const usage = toUsage(res.usage);
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

const ENV = {
  model: 'SINCLAIR_AGENT_MODEL', effort: 'SINCLAIR_AGENT_MODEL_EFFORT', requestTimeoutMs: 'SINCLAIR_AGENT_MODEL_TIMEOUT_MS',
  maxRetries: 'SINCLAIR_AGENT_MODEL_RETRIES', maxTokens: 'SINCLAIR_AGENT_MODEL_MAX_TOKENS', pixels: 'SINCLAIR_AGENT_MODEL_PIXELS',
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
  const pixels = env[ENV.pixels];
  if (pixels) {
    if (pixels !== '1' && pixels !== '0') throw new ModelConfigError(`${ENV.pixels}=${JSON.stringify(pixels)}: 1 또는 0 이어야 함`);
    if (pixels === '1') out.pixels = true;
  }
  return out;
}
