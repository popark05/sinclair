// 녹화 캐시(recording-cache 01): act 를 스테이징했다가 그 뒤 검증 스텝이 통과했으면 Attempt 끝에 저장소에 커밋한다.
import { describe, it, expect as vexpect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CACHE_KEY, parseCacheEntry, type RunEvent } from '@sinclair/protocol';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN, cacheStoreContractSuite, createMemoryCacheStore, SAMPLE_CACHE_ENTRY as SAMPLE_ENTRY } from '@sinclair/protocol/testing';
import { scriptedExecutor } from '@sinclair/agent';
import { runTests, cacheKey, createFileCacheStore } from '../src/index.ts';

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
    vexpect(report.tests[0]!.cache).toEqual({ saved: 1, unconfirmed: 0 });
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
