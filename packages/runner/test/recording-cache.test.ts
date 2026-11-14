// 녹화 캐시(recording-cache 01): act 를 스테이징했다가 그 뒤 검증 스텝이 통과했으면 Attempt 끝에 저장소에 커밋한다.
import { describe, it, expect as vexpect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CACHE_KEY, parseCacheEntry, type RunEvent, type SemanticNode } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN, cacheStoreContractSuite, createMemoryCacheStore, SAMPLE_CACHE_ENTRY as SAMPLE_ENTRY } from '@sinclair/protocol/testing';
import { scriptedExecutor, DEFAULT_SETTLE_CAP_MS } from '@sinclair/agent';
import { runTests, cacheKey, createFileCacheStore, CACHE_POLICY } from '../src/index.ts';

const fixture = (name: string) => path.resolve(import.meta.dirname, 'fixtures', name);
const engine = () => new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
const loginScript = () => scriptedExecutor([
  { name: 'type', input: { ref: '@e2', text: 'qa' } },
  { name: 'tap', input: { ref: '@e4' } },
  { name: 'done', input: { summary: '"환영합니다" 가 보인다' } },
]);
const acts = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: 'step.recorded' }> => e.type === 'step.recorded' && e.kind === 'act');

describe('cacheKey', () => {
  it('64자 16진수, instruction 정규화(CRLF·NFC·앞뒤 공백)에 같고, 테스트·앱·반복 번호·엔진이 다르면 다르다', () => {
    const base = { testId: 't', engine: 'mobile', app: 'com.a', instruction: '로그인', callIndex: 0 };
    const k = cacheKey(base);
    vexpect(CACHE_KEY.test(k)).toBe(true);
    vexpect(CACHE_POLICY).toBe('exact/3'); // exact/3: 입력창은 이름만 라벨(담긴 글자는 정체가 아니다, 2026-11-14 실기기)
    vexpect(cacheKey({ ...base, instruction: ' 로그인\r\n' })).toBe(k);
    vexpect(cacheKey({ ...base, instruction: '로그인'.normalize('NFD') })).toBe(k);
    for (const diff of [{ testId: 'u' }, { app: 'com.b' }, { callIndex: 1 }, { engine: 'fake' }, { instruction: '로그인 해' }]) vexpect(cacheKey({ ...base, ...diff })).not.toBe(k);
  });
});

describe('runTests · 녹화 캐시 기록', () => {
  it('act 뒤 검증(expect)이 통과하면 그 act 의 녹화가 저장소에 남는다: 키는 cacheKey, 항목은 계약을 통과, 스텝 cache 는 live', async () => {
    const store = createMemoryCacheStore();
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed' });
    vexpect(acts(report.events)).toEqual([vexpect.objectContaining({ cache: 'live' })]);
    const key = cacheKey({ testId: '에이전트가 로그인한다', engine: 'fake', app: 'com.app', instruction: '아이디 qa 로 로그인해줘', callIndex: 0 });
    const entry = await store.read(key);
    vexpect(parseCacheEntry(entry).ok).toBe(true);
    vexpect(entry!.actions.map((a) => [a.tool, a.target?.label ?? a.target?.placeholder])).toEqual([['type', '아이디'], ['tap', '로그인']]);
    vexpect(report.tests[0]!.cache).toEqual({ saved: 1, unconfirmed: 0, evicted: 0 });
  });

  it('뒤에 검증이 없으면(또는 검증 전에 실패하면) 저장하지 않는다', async () => {
    const store = createMemoryCacheStore();
    const report = await runTests([fixture('agent-login-unverified.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed', cache: { saved: 0, unconfirmed: 1 } });
    vexpect(store.size()).toBe(0);
  });

  it('같은 목표의 반복은 callIndex 로 따로 키를 갖고, 검증된 첫째만 저장된다', async () => {
    const store = createMemoryCacheStore();
    const exec = scriptedExecutor([
      { name: 'type', input: { ref: '@e2', text: 'qa' } }, { name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: 'ok' } },
      { name: 'type', input: { ref: '@e2', text: 'qa' } }, { name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: 'ok' } },
    ]);
    const report = await runTests([fixture('agent-login-twice.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: exec }, cache: { store } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed', cache: { saved: 1, unconfirmed: 1 } });
    const k = (i: number) => cacheKey({ testId: '로그인 두 번', engine: 'fake', app: 'com.app', instruction: '아이디 qa 로 로그인해줘', callIndex: i });
    vexpect(await store.read(k(0))).toBeDefined();
    vexpect(await store.read(k(1))).toBeUndefined();
  });

  it('cache 옵션이 없거나 mode off 면 스텝에 cache 가 없고 아무것도 쓰지 않는다', async () => {
    const store = createMemoryCacheStore();
    const off = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store, mode: 'off' } });
    vexpect(acts(off.events)[0]!.cache).toBeUndefined();
    vexpect(store.size()).toBe(0);
    const none = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() } });
    vexpect(acts(none.events)[0]!.cache).toBeUndefined();
    vexpect(none.tests[0]!.cache).toBeUndefined();
  });

  it('저장소 쓰기가 실패해도 테스트 결과는 그대로이고 경고만 남는다', async () => {
    const store = createMemoryCacheStore();
    store.write = async () => { throw new Error('디스크 가득'); };
    const report = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    vexpect(report.tests[0]).toMatchObject({ result: 'passed', warnings: [vexpect.stringMatching(/녹화 캐시 저장 실패.*디스크 가득/)] });
  });
});

describe('runTests · 녹화 재생', () => {
  const noModel = { next: () => Promise.reject(new Error('모델을 부르면 안 된다')) };

  it('같은 테스트를 다시 돌리면 녹화를 재생한다: 실행기를 부르지 않고 act 스텝은 cache replayed·modelCalls 0·"재생 2/2", 테스트 통과', async () => {
    const store = createMemoryCacheStore();
    await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    const again = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: noModel }, cache: { store } });
    vexpect(again.tests[0]).toMatchObject({ result: 'passed' });
    vexpect(acts(again.events)).toEqual([vexpect.objectContaining({ cache: 'replayed', modelCalls: 0, instruction: vexpect.stringMatching(/^act "아이디 qa 로 로그인해줘" → 재생 2\/2$/) })]);
  });

  it('재생 끝 대기 상한(cache.settleCapMs): 계속 바뀌는 화면(자동재생 영상)에서 그 상한에 끝난다 — 기본은 DEFAULT_SETTLE_CAP_MS(4초)', async () => {
    vexpect(DEFAULT_SETTLE_CAP_MS).toBe(4_000); // 실기 YouTube 검색 결과는 Enter 뒤 1.2~2.3초에 마지막 변화(2026-11-14)
    const store = createMemoryCacheStore();
    await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    // 로그인 뒤 홈 화면에 자막처럼 계속 바뀌는 노드
    let tick = 0;
    const live = engine();
    const observe = live.observe.bind(live);
    live.observe = async (o) => { const r = await observe(o); if (JSON.stringify(r.root).includes('환영합니다')) r.root.children = [...(r.root.children ?? []), { ref: '@sub', role: 'view', name: `자막 ${tick++}` }]; return r; };
    const started = Date.now();
    const again = await runTests([fixture('agent-login.sinclair.ts')], { engine: live, timeoutMs: 500, agent: { executor: noModel }, cache: { store, settleCapMs: 300 } });
    vexpect(again.tests[0]).toMatchObject({ result: 'passed' });
    vexpect(acts(again.events)[0]).toMatchObject({ cache: 'replayed' });
    vexpect(Date.now() - started).toBeLessThan(2_500); // 기본 상한(4초)이 아니라 준 상한에서 끝났다
  });

  it('녹화가 없으면 live 로 돈다(실행기 호출)', async () => {
    const store = createMemoryCacheStore();
    const r = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    vexpect(acts(r.events)[0]).toMatchObject({ cache: 'live', modelCalls: 3 });
  });

  it('첫 액션 전에 어긋나면(대상이 없음) live 로 돌고, 저장소 읽기 오류는 미스로 본다(경고)', async () => {
    const store = createMemoryCacheStore();
    await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    // 아이디 칸의 placeholder 가 바뀐 화면: 첫 액션부터 녹화와 맞지 않는다
    const changed: SemanticNode = structuredClone(LOGIN_SCREEN); changed.children![1] = { ...changed.children![1]!, placeholder: '아이디(이메일)' };
    const moved = new FakeEngine({ root: changed, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    const r = await runTests([fixture('agent-login.sinclair.ts')], { engine: moved, timeoutMs: 500, agent: { executor: loginScript() }, cache: { store, findTimeoutMs: 100 } });
    vexpect(r.tests[0]).toMatchObject({ result: 'passed' });
    vexpect(acts(r.events)[0]).toMatchObject({ cache: 'live', modelCalls: 3 });
    const broken = createMemoryCacheStore();
    broken.read = async () => { throw new Error('네트워크'); };
    const r2 = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store: broken } });
    vexpect(r2.tests[0]).toMatchObject({ result: 'passed', warnings: [vexpect.stringMatching(/녹화 캐시 읽기 실패.*네트워크/)] });
  });
});

describe('runTests · 이어받기와 지우기', () => {
  it('재생이 중간에 어긋나면 그 화면부터 에이전트가 이어받는다: 접두부 안내, cache handed-off, 성공·검증 뒤 녹화는 재생분 + 이어받은 분으로 갱신', async () => {
    const store = createMemoryCacheStore();
    await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    // 로그인 버튼 이름이 바뀐 앱: 아이디 입력(1/2)까지 재생되고 버튼에서 어긋난다
    const renamed: SemanticNode = structuredClone(LOGIN_SCREEN); renamed.children![3] = { ...renamed.children![3]!, name: '로그인하기' };
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: '환영합니다' } }]);
    const app2 = new FakeEngine({ root: renamed, onTap: (n) => (n.name === '로그인하기' ? HOME_SCREEN : undefined) });
    const r = await runTests([fixture('agent-login.sinclair.ts')], { engine: app2, timeoutMs: 500, agent: { executor: exec }, cache: { store, findTimeoutMs: 100 } });
    vexpect(r.tests[0]).toMatchObject({ result: 'passed', cache: { saved: 1, unconfirmed: 0 } });
    vexpect(acts(r.events)[0]).toMatchObject({ cache: 'handed-off', modelCalls: 2, instruction: vexpect.stringMatching(/재생 1\/2 뒤 이어받음\(.*로그인.*\) → tap @e4/) });
    vexpect(exec.requests[0]!.handOff).toMatch(/type textbox \[아이디\]/);
    const key = cacheKey({ testId: '에이전트가 로그인한다', engine: 'fake', app: 'com.app', instruction: '아이디 qa 로 로그인해줘', callIndex: 0 });
    vexpect((await store.read(key))!.actions.map((a) => a.summary)).toEqual(['type textbox [아이디]', 'tap button "로그인하기"']);
  });

  it('재생에 쓴 녹화가 검증 실패와 함께였으면 지운다(다음엔 라이브로 다시 녹화)', async () => {
    const store = createMemoryCacheStore();
    await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    const key = cacheKey({ testId: '에이전트가 로그인한다', engine: 'fake', app: 'com.app', instruction: '아이디 qa 로 로그인해줘', callIndex: 0 });
    vexpect(await store.read(key)).toBeDefined();
    const r = await runTests([fixture('agent-login-broken.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: { next: () => Promise.reject(new Error('x')) } }, cache: { store } });
    vexpect(r.tests[0]).toMatchObject({ result: 'failed' });
    vexpect(acts(r.events)[0]).toMatchObject({ cache: 'replayed' });
    vexpect(await store.read(key)).toBeUndefined();
    vexpect(r.tests[0]!.cache).toMatchObject({ evicted: 1 });
  });
});

describe('runTests · 캐시 모드(recording-cache 04)', () => {
  const noModel = { next: () => Promise.reject(new Error('모델을 부르면 안 된다')) };
  const recorded = async () => {
    const store = createMemoryCacheStore();
    await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store } });
    return store;
  };
  const renamedApp = () => {
    const renamed: SemanticNode = structuredClone(LOGIN_SCREEN); renamed.children![3] = { ...renamed.children![3]!, name: '로그인하기' };
    return new FakeEngine({ root: renamed, onTap: (n) => (n.name === '로그인하기' ? HOME_SCREEN : undefined) });
  };

  it('read-only: 재생은 하지만 라이브로 돈 act 를 기록하지 않고, 실패해도 지우지 않는다', async () => {
    const empty = createMemoryCacheStore();
    const live = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: loginScript() }, cache: { store: empty, mode: 'read-only' } });
    vexpect(acts(live.events)[0]).toMatchObject({ cache: 'live' });
    vexpect(empty.size()).toBe(0);
    const store = await recorded();
    const broken = await runTests([fixture('agent-login-broken.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: noModel }, cache: { store, mode: 'read-only' } });
    vexpect(acts(broken.events)[0]).toMatchObject({ cache: 'replayed' });
    vexpect(store.size()).toBe(1);
  });

  it('strict: 녹화가 없으면 모델을 부르지 않고 실패(cache-miss)', async () => {
    const r = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, retries: 2, agent: { executor: noModel }, cache: { store: createMemoryCacheStore(), mode: 'strict' } });
    vexpect(r.tests[0]).toMatchObject({ result: 'failed', errorCode: 'cache-miss', attempts: 1, error: vexpect.stringMatching(/녹화가 없음/) }); // 결정적 판정이라 재시도하지 않는다
  });

  it('strict: 재생이 어긋나면 이어받지 않고 실패(cache-stale), 녹화는 그대로', async () => {
    const store = await recorded();
    const r = await runTests([fixture('agent-login.sinclair.ts')], { engine: renamedApp(), timeoutMs: 500, agent: { executor: noModel }, cache: { store, mode: 'strict', findTimeoutMs: 100 } });
    vexpect(r.tests[0]).toMatchObject({ result: 'failed', errorCode: 'cache-stale', error: vexpect.stringMatching(/재생 1\/2.*로그인/) });
    vexpect(store.size()).toBe(1);
  });

  it('strict: 녹화대로 재생되면 통과하고 재시도에서도 재생한다', async () => {
    const store = await recorded();
    const r = await runTests([fixture('agent-login.sinclair.ts')], { engine: engine(), timeoutMs: 500, agent: { executor: noModel }, cache: { store, mode: 'strict' } });
    vexpect(r.tests[0]).toMatchObject({ result: 'passed' });
    vexpect(acts(r.events)[0]).toMatchObject({ cache: 'replayed' });
  });

  it('read-write(기본): 재시도 Attempt 는 재생하지 않고 라이브로 돈다', async () => {
    const store = await recorded();
    const r = await runTests([fixture('agent-login-broken.sinclair.ts')], { engine: engine(), timeoutMs: 500, retries: 1, agent: { executor: loginScript() }, cache: { store } });
    vexpect(acts(r.events).map((e) => e.cache)).toEqual(['replayed', 'live']);
  });
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-cache-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
cacheStoreContractSuite('file', () => createFileCacheStore(dir), SAMPLE_ENTRY);

describe('createFileCacheStore', () => {
  it('<dir>/<key>.json 에 쓰고, 계약을 통과하지 못하는 파일은 미스로 본다', async () => {
    const store = createFileCacheStore(dir);
    const key = 'b'.repeat(64);
    await store.write(key, SAMPLE_ENTRY);
    vexpect(fs.existsSync(path.join(dir, `${key}.json`))).toBe(true);
    fs.writeFileSync(path.join(dir, `${key}.json`), '{"schema":"rc-0"}');
    vexpect(await store.read(key)).toBeUndefined();
  });
});
