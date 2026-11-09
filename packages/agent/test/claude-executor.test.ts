// Claude 실행기: 가짜 Messages API 서버(SDK 의 baseURL)로 요청 본문을 가로채 무엇이 모델에 가는지, 응답이 어떻게 툴 호출·사용량이 되는지 본다.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginScenario, FakeEngine, LOGIN_SCREEN, HOME_SCREEN } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { createClaudeExecutor, claudeOptionsFromEnv, probeClaude, runAct, judgeAssert, judgeExtract, SecretBox, secretPlaceholder, toolSchemas, DEFAULT_AGENT_MODEL, ModelConfigError, type ClaudeExecutorOptions } from '../src/index.ts';

const KEY = 'sk-ant-test-0123456789abcdef';
type Reply = { status?: number; body: unknown };
interface Captured { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown>; raw: string }

let server: http.Server | undefined;
afterEach(async () => { vi.unstubAllEnvs(); await new Promise((r) => (server ? server.close(r) : r(undefined))); server = undefined; });

/** 요청마다 replies 를 차례로 돌려주는 가짜 API. 받은 요청은 captured 에 */
async function fakeApi(replies: Array<Reply | ((req: Captured) => Reply)>): Promise<{ baseURL: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const c: Captured = { url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown>, raw };
      captured.push(c);
      const next = replies[Math.min(captured.length - 1, replies.length - 1)]!;
      const r = typeof next === 'function' ? next(c) : next;
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { baseURL: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, captured };
}

const usage = (input: number, output: number, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
const toolUse = (name: string, input: Record<string, string>, u = usage(1200, 40)): Reply => ({
  body: { id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_AGENT_MODEL, stop_reason: 'tool_use', stop_sequence: null, usage: u,
    content: [{ type: 'text', text: '로그인 칸에 입력한다' }, { type: 'tool_use', id: 'toolu_1', name, input }] },
});
const LOGIN: Reply[] = [
  toolUse('type', { ref: '@e2', text: 'qa' }), toolUse('type', { ref: '@e3', text: 'qa-pass' }, usage(300, 30, 900)),
  toolUse('tap', { ref: '@e4' }, usage(300, 20, 900)), toolUse('done', { summary: '환영합니다 가 보인다' }, usage(300, 25, 900)),
];
const opts = (baseURL: string, extra: Partial<ClaudeExecutorOptions> = {}): ClaudeExecutorOptions => ({ apiKey: KEY, baseURL, maxRetries: 0, ...extra });

describe('createClaudeExecutor', () => {
  it('실제 모델 경로로 FakeEngine 로그인을 끝내고, 턴마다 토큰 사용량을 모은다', async () => {
    const api = await fakeApi(LOGIN);
    const r = await runAct(loginScenario(), '아이디 qa, 비밀번호 qa-pass 로 로그인해줘', { executor: createClaudeExecutor(opts(api.baseURL)) });
    expect(r).toMatchObject({ ok: true, turns: 4, modelCalls: 4, usage: { inputTokens: 2100, outputTokens: 115, cacheReadTokens: 2700 } });
    expect(r.usage).not.toHaveProperty('cacheWriteTokens'); // 0 은 남기지 않는다
    expect(api.captured).toHaveLength(4);
  });

  it('요청: 기본 Sonnet 5.5·effort medium, action spec 툴을 그대로(strict), 툴 하나씩, 서버 측 fallback, 고정 system 에 캐시 표시', async () => {
    const api = await fakeApi(LOGIN);
    await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api.baseURL)) });
    const b = api.captured[0]!.body;
    expect(b).toMatchObject({ model: 'claude-sonnet-5-5', fallbacks: 'default', output_config: { effort: 'medium' }, tool_choice: { type: 'auto', disable_parallel_tool_use: true } });
    expect(api.captured[0]!.headers['anthropic-beta']).toMatch(/server-side-fallback-2026-07-01/);
    expect(b.tools).toEqual(toolSchemas().map((t) => ({ ...t, strict: true })));
    const system = b.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    // 매 턴 같은 system·툴이라 캐시가 맞는다(바뀌는 것은 user 메시지뿐)
    expect(api.captured[3]!.body.system).toEqual(b.system);
    expect(api.captured[3]!.body.tools).toEqual(b.tools);
    expect(b.messages).toHaveLength(1);
  });

  it('개인정보·비밀: secure 값·API 키·지난 턴에 입력한 글자는 요청 본문에 없고, 키는 헤더로만 간다. 기본은 이미지 없음', async () => {
    const api = await fakeApi(LOGIN);
    await runAct(loginScenario(), '로그인해줘', { executor: createClaudeExecutor(opts(api.baseURL)) });
    for (const c of api.captured) {
      expect(c.raw).not.toContain('hunter2'); // 비밀번호 칸(secure)의 값
      expect(c.raw).not.toContain(KEY);
      expect(c.raw).not.toContain('"image"');
      expect(c.headers['x-api-key'] === KEY || c.headers.authorization === `Bearer ${KEY}`).toBe(true);
    }
    const last = JSON.stringify(api.captured[3]!.body.messages);
    expect(last).not.toContain('qa-pass'); // 지난 턴의 type 글자는 가린다
    expect(last).toMatch(/type @e3/);
  });

  it('pixels 를 켜면 화면 이미지를 함께 보낸다', async () => {
    const api = await fakeApi(LOGIN);
    await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api.baseURL, { pixels: true })) });
    const content = (api.captured[0]!.body.messages as Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>)[0]!.content;
    expect(content.find((p) => p.type === 'image')?.source?.media_type).toBe('image/png');
  });

  it('툴 없이 글만 내면 거부로 되돌려 다시 묻고, 거절은 범주와 함께 실패(쓴 토큰 포함)', async () => {
    const text: Reply = { body: { id: 'm', type: 'message', role: 'assistant', model: DEFAULT_AGENT_MODEL, stop_reason: 'end_turn', stop_sequence: null, usage: usage(100, 10), content: [{ type: 'text', text: '무엇을 할까요?' }] } };
    const api = await fakeApi([text, ...LOGIN]);
    const r = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api.baseURL)) });
    expect(r).toMatchObject({ ok: true, turns: 5 });
    expect(JSON.stringify(api.captured[1]!.body.messages)).toMatch(/툴을 부르지 않음/);

    const refusal: Reply = { body: { id: 'm', type: 'message', role: 'assistant', model: DEFAULT_AGENT_MODEL, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null }, stop_sequence: null, usage: usage(80, 0), content: [] } };
    const api2 = await fakeApi([refusal]);
    const f = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api2.baseURL)) });
    expect(f).toMatchObject({ ok: false, modelCalls: 1, reason: expect.stringMatching(/거절.*general_harms/), usage: { inputTokens: 80, outputTokens: 0 } });
  });

  it('일시 오류(5xx·429)는 재시도하고, 그 밖의 API 오류는 재시도하지 않는다', async () => {
    const overloaded: Reply = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
    const api = await fakeApi([overloaded, ...LOGIN]);
    const r = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api.baseURL, { maxRetries: 2 })) });
    expect(r).toMatchObject({ ok: true, modelCalls: 4 });
    expect(api.captured).toHaveLength(5);

    const bad: Reply = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad tools' } } };
    const api2 = await fakeApi([bad]);
    await expect(runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api2.baseURL, { maxRetries: 2 })) })).rejects.toThrow(/400/);
    expect(api2.captured).toHaveLength(1); // 재시도하지 않는다
  });

  it('키가 없거나(자격 증명 없음) 거부되면(401) 분명한 설정 오류로 던진다 — 키 값은 메시지에 없다', async () => {
    // 이 머신의 자격 증명(환경변수·프로필)을 모두 가린다
    for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_FEDERATION_RULE_ID']) vi.stubEnv(v, undefined);
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-no-creds-')));
    const noKey = createClaudeExecutor({ baseURL: 'http://127.0.0.1:9', maxRetries: 0 });
    await expect(runAct(loginScenario(), '로그인', { executor: noKey })).rejects.toThrow(ModelConfigError);
    await expect(runAct(loginScenario(), '로그인', { executor: noKey })).rejects.toThrow(/ANTHROPIC_API_KEY/);

    const api = await fakeApi([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
    const err = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api.baseURL)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelConfigError);
    expect(String((err as Error).message)).not.toContain(KEY);
  });
});

describe('createClaudeExecutor · 오류 분류(리뷰 반영)', () => {
  it('요청 모양 오류(400·413·422)는 결정적이라 설정 오류이고 API 의 사유를 싣는다', async () => {
    const api = await fakeApi([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 99999 > 64000, which is the maximum allowed' } } }]);
    const err = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(api.baseURL)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelConfigError);
    expect((err as Error).message).toMatch(/400.*max_tokens: 99999/);
  });

  it('자격 증명 사슬 오류(없는 프로필 등)도 설정 오류', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-no-creds-')));
    vi.stubEnv('ANTHROPIC_PROFILE', 'no-such-profile');
    const err = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor({ baseURL: 'http://127.0.0.1:9', maxRetries: 0 }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelConfigError);
  });

  it('요청 기한 초과는 기한으로 알린다(CA 안내를 붙이지 않는다)', async () => {
    server = http.createServer(() => { /* 답하지 않는다 */ });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await runAct(loginScenario(), '로그인', { executor: createClaudeExecutor(opts(baseURL, { requestTimeoutMs: 200 })) });
    expect(r.reason).toMatch(/기한/);
    expect(r.reason).not.toMatch(/NODE_EXTRA_CA_CERTS/);
    server.closeAllConnections();
  });
});

describe('createClaudeExecutor · judge(판정 동사)', () => {
  const jsonReply = (answer: unknown, extra: Record<string, unknown> = {}): Reply => ({
    body: { id: 'm', type: 'message', role: 'assistant', model: DEFAULT_AGENT_MODEL, stop_reason: 'end_turn', stop_sequence: null, usage: usage(500, 20), content: [{ type: 'text', text: JSON.stringify(answer) }], ...extra },
  });

  it('툴 없이 구조화 출력(json_schema)으로 묻고, 답 JSON 을 판정으로 쓴다. secure 값은 본문에 없다', async () => {
    const api = await fakeApi([jsonReply({ pass: true, reason: '로그인 버튼이 보인다' })]);
    const r = await judgeAssert(loginScenario(), '로그인 화면이다', { executor: createClaudeExecutor(opts(api.baseURL)) });
    expect(r).toMatchObject({ ok: true, reason: '로그인 버튼이 보인다', modelCalls: 1, usage: { inputTokens: 500, outputTokens: 20 } });
    const b = api.captured[0]!.body;
    expect(b).not.toHaveProperty('tools');
    expect(b).not.toHaveProperty('tool_choice');
    expect(b).toMatchObject({ model: 'claude-sonnet-5-5', fallbacks: 'default', output_config: { effort: 'medium', format: { type: 'json_schema', schema: { required: ['pass', 'reason'] } } } });
    expect(JSON.stringify(b.messages)).toMatch(/로그인 화면이다/);
    expect(api.captured[0]!.raw).not.toContain('hunter2');
    expect(api.captured[0]!.raw).not.toContain(KEY);
  });

  it('extract 는 요청한 타입의 스키마로 묻는다', async () => {
    const api = await fakeApi([jsonReply({ found: true, value: 'Sinclair 로그인', sourceRefs: ['@e1'], reason: '제목' })]);
    const r = await judgeExtract(loginScenario(), '화면 제목', 'string', { executor: createClaudeExecutor(opts(api.baseURL)) });
    expect(r).toMatchObject({ ok: true, value: 'Sinclair 로그인' });
    expect(api.captured[0]!.body).toMatchObject({ output_config: { format: { schema: { properties: { value: { type: 'string' } } } } } });
  });

  it('거절·JSON 이 아닌 답은 invalid 판정(쓴 토큰 포함)', async () => {
    const api = await fakeApi([jsonReply(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] })]);
    expect(await judgeAssert(loginScenario(), 'x', { executor: createClaudeExecutor(opts(api.baseURL)) })).toMatchObject({ ok: false, failure: 'invalid', reason: expect.stringMatching(/거절.*cyber/), usage: { inputTokens: 500 } });
    const api2 = await fakeApi([{ body: { ...(jsonReply({}).body as object), content: [{ type: 'text', text: '참입니다' }] } }]);
    expect(await judgeAssert(loginScenario(), 'x', { executor: createClaudeExecutor(opts(api2.baseURL)) })).toMatchObject({ ok: false, failure: 'invalid', reason: expect.stringMatching(/JSON/) });
  });
});

describe('createClaudeExecutor · Ledger', () => {
  const longHistory = (n: number) => Array.from({ length: n }, (_, i) => ({ call: { name: 'tap', input: { ref: `@e${i + 1}` } }, result: 'ok' as const }));
  const textReply = (text: string): Reply => ({ body: { id: 's', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: usage(200, 30), content: [{ type: 'text', text }] } });

  it('프롬프트는 Ledger 로: 오래된 턴은 묶음 요약, 예산을 넘지 않는다', async () => {
    const api = await fakeApi([toolUse('done', { summary: 'x' })]);
    await createClaudeExecutor(opts(api.baseURL, { ledgerBudget: 3000 })).next({ goal: '목표', observation: '@r root', history: longHistory(30), tools: [] }, new AbortController().signal);
    const prompt = JSON.stringify(api.captured[0]!.body.messages);
    expect(prompt).toMatch(/턴 1–8 요약: tap 8\(ok 8\)/);
    expect(prompt).toContain('30. tap @e30');
  });

  it('요약 모델을 설정하면 접힌 묶음을 그 모델이 요약하고(한 번만), 쓴 토큰이 그 턴에 더해진다', async () => {
    const api = await fakeApi([(c) => (c.body.model === 'claude-haiku-5-5' ? textReply('설정 앱에서 알림 메뉴까지 갔다') : toolUse('done', { summary: 'x' }, usage(1000, 10)))]);
    const exec = createClaudeExecutor(opts(api.baseURL, { ledgerSummaryModel: 'claude-haiku-5-5' }));
    const first = await exec.next({ goal: '목표', observation: '@r root', history: longHistory(17), tools: [] }, new AbortController().signal);
    expect(api.captured.map((c) => c.body.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(JSON.stringify(api.captured[1]!.body.messages)).toMatch(/턴 1–8 요약\(요약 모델, 참고용\): 설정 앱에서 알림 메뉴까지 갔다/);
    expect(first.usage).toMatchObject({ inputTokens: 1200, outputTokens: 40 });
    await exec.next({ goal: '목표', observation: '@r root', history: longHistory(18), tools: [] }, new AbortController().signal);
    expect(api.captured.map((c) => c.body.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']); // 같은 묶음은 다시 요약하지 않는다
  });

  it('요약 캐시는 묶음 내용(목표+턴)으로: 같은 실행기를 쓰는 다른 act 에 남의 요약이 가지 않는다', async () => {
    let k = 0;
    const api = await fakeApi([(c) => (c.body.model === 'claude-haiku-5-5' ? textReply(`요약 ${++k}`) : toolUse('done', { summary: 'x' }))]);
    const exec = createClaudeExecutor(opts(api.baseURL, { ledgerSummaryModel: 'claude-haiku-5-5' }));
    await exec.next({ goal: '목표 A', observation: '@r root', history: longHistory(17), tools: [] }, new AbortController().signal);
    await exec.next({ goal: '목표 B', observation: '@r root', history: longHistory(17), tools: [] }, new AbortController().signal);
    expect(JSON.stringify(api.captured.at(-1)!.body.messages)).toMatch(/요약 2/);
  });

  it('요약 모델 설정이 틀리면(404) 그 변수를 밝힌 설정 오류', async () => {
    const api = await fakeApi([(c) => (c.body.model === 'claude-haiku-typo' ? { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model' } } } : toolUse('done', { summary: 'x' }))]);
    await expect(createClaudeExecutor(opts(api.baseURL, { ledgerSummaryModel: 'claude-haiku-typo' })).next({ goal: '목표', observation: '@r root', history: longHistory(17), tools: [] }, new AbortController().signal)).rejects.toThrow(/SINCLAIR_AGENT_LEDGER_SUMMARY_MODEL/);
  });

  it('본 요청이 실패해도 요약에 쓴 토큰은 오류에 실린다', async () => {
    const api = await fakeApi([(c) => (c.body.model === 'claude-haiku-5-5' ? textReply('요약') : { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'x' } } })]);
    const err = await createClaudeExecutor(opts(api.baseURL, { ledgerSummaryModel: 'claude-haiku-5-5' })).next({ goal: '목표', observation: '@r root', history: longHistory(17), tools: [] }, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ usage: { inputTokens: 200, outputTokens: 30 } });
  });

  it('요약 모델이 일시 오류(5xx)로 실패하면 결정적 요약으로 돌아가고 턴은 계속된다', async () => {
    const api = await fakeApi([(c) => (c.body.model === 'claude-haiku-5-5' ? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } } : toolUse('done', { summary: 'x' }))]);
    const r = await createClaudeExecutor(opts(api.baseURL, { ledgerSummaryModel: 'claude-haiku-5-5' })).next({ goal: '목표', observation: '@r root', history: longHistory(17), tools: [] }, new AbortController().signal);
    expect(r.call).toMatchObject({ name: 'done' });
    expect(JSON.stringify(api.captured.at(-1)!.body.messages)).toMatch(/턴 1–8 요약: tap 8/);
  });
});

describe('createClaudeExecutor · fetch 주입(증거 기록용)', () => {
  it('주어진 fetch 로 요청을 보낸다 — 증거 스크립트가 요청 본문을 기록해 비밀값이 없음을 확인할 수 있게', async () => {
    const api = await fakeApi([toolUse('done', { summary: 'x' })]);
    const bodies: string[] = [];
    const recording: typeof fetch = async (input, init) => { if (typeof init?.body === 'string') bodies.push(init.body); return fetch(input, init); };
    await createClaudeExecutor(opts(api.baseURL, { fetch: recording })).next({ goal: '목표', observation: '@r root', history: [], tools: [] }, new AbortController().signal);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ model: 'claude-sonnet-5-5' });
  });
});

describe('probeClaude', () => {
  it('닿으면 ok, 닿지 않으면 unreachable, 키가 거부되면 설정 오류', async () => {
    const api = await fakeApi([{ body: { input_tokens: 3 } }]);
    expect(await probeClaude(opts(api.baseURL))).toBe('ok');
    expect(api.captured[0]!.url).toMatch(/count_tokens/);
    expect(await probeClaude(opts('http://127.0.0.1:9'))).toBe('unreachable');
    const denied = await fakeApi([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'x' } } }]);
    await expect(probeClaude(opts(denied.baseURL))).rejects.toBeInstanceOf(ModelConfigError);
  });
});

describe('createClaudeExecutor · Incident', () => {
  it('자동 복구하지 못한 Incident 는 그 턴의 프롬프트에 먼저 해결하라고 실린다', async () => {
    const api = await fakeApi([toolUse('done', { summary: 'x' })]);
    const exec = createClaudeExecutor(opts(api.baseURL));
    await exec.next({ goal: '결제', observation: '@a button "결제"', history: [], tools: [], incident: 'Incident: 다른 앱(com.android.chrome)으로 넘어감' }, new AbortController().signal);
    expect(JSON.stringify(api.captured[0]!.body.messages)).toMatch(/Incident: 다른 앱\(com.android.chrome\)/);
  });
});

describe('createClaudeExecutor · 비밀값', () => {
  it('비밀번호 칸이 secure 가 아니어도 요청 본문(목표·관찰·지난 턴)에는 자리표시만, 엔진에는 실제 값', async () => {
    const VALUE = 'Tr0ub4dor&3';
    const P = secretPlaceholder('QA_PASSWORD');
    const root: SemanticNode = structuredClone(LOGIN_SCREEN);
    root.children![2] = { ref: '@e3', role: 'textbox', placeholder: '비밀번호' };
    const engine = new FakeEngine({ root, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    const perform = engine.perform.bind(engine);
    engine.perform = async (ref, action, arg) => { await perform(ref, action, arg); if (action === 'type' && ref === '@e3') { const r = structuredClone(root); r.children![2]!.value = arg ?? ''; engine.setRoot(r); } };
    const api = await fakeApi([toolUse('type', { ref: '@e3', text: P }), toolUse('tap', { ref: '@e4' }), toolUse('done', { summary: '환영합니다' })]);
    const r = await runAct(engine, `비밀번호 ${P} 로 로그인`, { executor: createClaudeExecutor(opts(api.baseURL)), secrets: new SecretBox([['QA_PASSWORD', VALUE]]) });
    expect(r.ok).toBe(true);
    expect(engine.performed).toContainEqual({ ref: '@e3', action: 'type', arg: VALUE });
    expect(api.captured[1]!.raw).toContain('secret:QA_PASSWORD'); // 칸에 보인 값은 자리표시로 관찰됐다
    for (const c of api.captured) expect(c.raw).not.toContain(VALUE);
  });
});

describe('claudeOptionsFromEnv', () => {
  it('환경변수로 모델·effort·요청 기한·재시도·최대 토큰·이미지를 바꾼다. 없으면 기본값', () => {
    expect(claudeOptionsFromEnv({})).toEqual({});
    expect(claudeOptionsFromEnv({ SINCLAIR_AGENT_MODEL: 'claude-opus-5-5', SINCLAIR_AGENT_MODEL_EFFORT: 'high', SINCLAIR_AGENT_MODEL_TIMEOUT_MS: '30000', SINCLAIR_AGENT_MODEL_RETRIES: '0', SINCLAIR_AGENT_MODEL_MAX_TOKENS: '4096', SINCLAIR_AGENT_MODEL_PIXELS: '1' }))
      .toEqual({ model: 'claude-opus-5-5', effort: 'high', requestTimeoutMs: 30000, maxRetries: 0, maxTokens: 4096, pixels: true });
    expect(claudeOptionsFromEnv({ SINCLAIR_AGENT_LEDGER_BUDGET: '12000', SINCLAIR_AGENT_LEDGER_SUMMARY_MODEL: 'claude-haiku-5-5' })).toEqual({ ledgerBudget: 12000, ledgerSummaryModel: 'claude-haiku-5-5' });
    expect(() => claudeOptionsFromEnv({ SINCLAIR_AGENT_LEDGER_BUDGET: '10' })).toThrow(/SINCLAIR_AGENT_LEDGER_BUDGET/);
  });

  it('잘못된 값은 어느 변수인지 밝힌 설정 오류', () => {
    expect(() => claudeOptionsFromEnv({ SINCLAIR_AGENT_MODEL_EFFORT: 'turbo' })).toThrow(/SINCLAIR_AGENT_MODEL_EFFORT/);
    expect(() => claudeOptionsFromEnv({ SINCLAIR_AGENT_MODEL_RETRIES: '-1' })).toThrow(ModelConfigError);
    expect(() => claudeOptionsFromEnv({ SINCLAIR_AGENT_MODEL_MAX_TOKENS: 'lots' })).toThrow(/SINCLAIR_AGENT_MODEL_MAX_TOKENS/);
    expect(() => claudeOptionsFromEnv({ SINCLAIR_AGENT_MODEL_PIXELS: 'yes' })).toThrow(/SINCLAIR_AGENT_MODEL_PIXELS/);
  });
});

describe('agentFromEnv', () => {
  it('act 한도(SINCLAIR_AGENT_ACT_*)와 실행기를 한 벌로 만든다. 잘못된 한도는 설정 오류', async () => {
    const { agentFromEnv } = await import('../src/index.ts');
    expect(agentFromEnv({})).toEqual({ executor: expect.any(Object) });
    expect(agentFromEnv({ SINCLAIR_AGENT_ACT_MAX_TURNS: '8', SINCLAIR_AGENT_ACT_TIMEOUT_MS: '60000' })).toMatchObject({ maxTurns: 8, timeoutMs: 60000 });
    expect(() => agentFromEnv({ SINCLAIR_AGENT_ACT_MAX_TURNS: '0' })).toThrow(/SINCLAIR_AGENT_ACT_MAX_TURNS/);
    expect(agentFromEnv({ SINCLAIR_AGENT_MODEL_PIXELS: '1' }).executor.pixels).toBe(true);
    expect(agentFromEnv({ SINCLAIR_AGENT_ACT_SAFETY_PIXELS: '1' })).toMatchObject({ safetyNet: { pixels: true } });
    expect(() => agentFromEnv({ SINCLAIR_AGENT_ACT_SAFETY_PIXELS: 'on' })).toThrow(/SAFETY_PIXELS/);
    expect(agentFromEnv({ SINCLAIR_AGENT_ACT_PERMISSION: 'deny' })).toMatchObject({ incidents: { permission: 'deny' } });
    expect(() => agentFromEnv({ SINCLAIR_AGENT_ACT_PERMISSION: 'maybe' })).toThrow(/SINCLAIR_AGENT_ACT_PERMISSION/);
  });
});
