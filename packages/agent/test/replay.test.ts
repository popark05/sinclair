// 녹화 재생(recording-cache 02): 녹화한 기술자와 정확히 하나 일치하는 노드에 같은 툴을 다시 하고, 끝 anchor 와 화면 변화로 확인한다. 모델 없음.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { CACHE_SCHEMA, type CacheEntry, type SemanticNode } from '@sinclair/protocol';
import { replayRecording, runAct, renderLedger, scriptedExecutor, SecretBox, secretPlaceholder, exactMatches, cacheTargetOf } from '../src/index.ts';

const P = secretPlaceholder('QA_PASSWORD');
const VALUE = 'Tr0ub4dor&3';
const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  schema: CACHE_SCHEMA, createdAt: 'x', recordedBy: {}, start: { app: 'com.app' },
  actions: [
    { tool: 'type', target: { role: 'textbox', testId: 'com.app:id/username', placeholder: '아이디' }, text: 'qa', summary: 'type textbox [아이디]' },
    { tool: 'type', target: { role: 'textbox', testId: 'com.app:id/password', placeholder: '비밀번호' }, text: P, summary: 'type textbox [비밀번호]' },
    { tool: 'tap', target: { role: 'button', label: '로그인' }, summary: 'tap button "로그인"' },
  ],
  end: { anchors: [{ role: 'text', label: '환영합니다' }, { role: 'button', label: '로그아웃' }] },
  ...over,
});
const login = (onTap?: (n: SemanticNode) => SemanticNode | undefined) => new FakeEngine({ root: LOGIN_SCREEN, onTap: onTap ?? ((n) => (n.name === '로그인' ? HOME_SCREEN : undefined)) });
const secrets = () => new SecretBox([['QA_PASSWORD', VALUE]]);
const goal = `아이디 qa, 비밀번호 ${P} 로 로그인`;

describe('replayRecording', () => {
  it('모든 액션이 정확히 하나 일치하고 끝 anchor 가 보이면 replayed: 비밀값은 이번 실행 값으로 입력된다', async () => {
    const engine = login();
    const r = await replayRecording(engine, entry(), { goal, secrets: secrets() });
    expect(r).toMatchObject({ outcome: 'replayed', executed: 3, total: 3 });
    expect(engine.performed.map((p) => [p.ref, p.action, p.arg])).toEqual([['@e2', 'type', 'qa'], ['@e3', 'type', VALUE], ['@e4', 'tap', undefined]]);
  });

  it('시작 앱이 다르면 아무것도 하지 않고 missed(전제 불일치)', async () => {
    const engine = login();
    const r = await replayRecording(engine, entry({ start: { app: 'com.other' } }), { goal, secrets: secrets() });
    expect(r).toMatchObject({ outcome: 'missed', executed: 0, reason: expect.stringMatching(/앱/) });
    expect(engine.performed).toEqual([]);
  });

  it('첫 대상이 기다려도 없으면 missed, 둘 이상이면 곧바로 missed(애매함)', async () => {
    const gone = await replayRecording(login(), entry({ actions: [{ tool: 'tap', target: { role: 'button', label: '없는 버튼' }, summary: 'tap' }] }), { goal, secrets: secrets(), findTimeoutMs: 200 });
    expect(gone).toMatchObject({ outcome: 'missed', executed: 0, reason: expect.stringMatching(/찾지 못함/) });
    const twins: SemanticNode = { ...structuredClone(LOGIN_SCREEN), children: [...structuredClone(LOGIN_SCREEN).children!, { ref: '@e9', role: 'button', name: '로그인' }] };
    const t0 = Date.now();
    const amb = await replayRecording(new FakeEngine({ root: twins }), entry(), { goal, secrets: secrets(), findTimeoutMs: 2000 });
    expect(amb).toMatchObject({ outcome: 'diverged', executed: 2, reason: expect.stringMatching(/애매/) });
    expect(Date.now() - t0).toBeLessThan(1000); // 애매함은 기다리지 않는다
  });

  it('정체 필드가 하나라도 다르면 같은 대상이 아니다(이름이 바뀐 버튼): 앞 액션까지 한 뒤 diverged, 한 액션 요약을 돌려준다', async () => {
    const renamed: SemanticNode = structuredClone(LOGIN_SCREEN);
    renamed.children![3] = { ...renamed.children![3]!, name: '로그인하기' };
    const r = await replayRecording(new FakeEngine({ root: renamed }), entry(), { goal, secrets: secrets(), findTimeoutMs: 200 });
    expect(r).toMatchObject({ outcome: 'diverged', executed: 2, total: 3, done: ['type textbox [아이디]', 'type textbox [비밀번호]'], reason: expect.stringMatching(/tap button "로그인".*찾지 못함/) });
  });

  it('끝 anchor 는 과반만 보이면 된다(자동재생 영상 버튼 같은 우연한 UI 에 흔들리지 않게)', async () => {
    const e = entry({ end: { anchors: [{ role: 'text', label: '환영합니다' }, { role: 'button', label: '로그아웃' }, { role: 'button', label: '음소거' }] } });
    expect(await replayRecording(login(), e, { goal, secrets: secrets(), endTimeoutMs: 200 })).toMatchObject({ outcome: 'replayed' });
    const e2 = entry({ end: { anchors: [{ role: 'text', label: '환영합니다' }, { role: 'button', label: '음소거' }, { role: 'button', label: '광고' }] } });
    expect(await replayRecording(login(), e2, { goal, secrets: secrets(), endTimeoutMs: 200 })).toMatchObject({ outcome: 'diverged', reason: expect.stringMatching(/끝 화면/) });
  });

  it('이름 없는 대상은 자식 글자로 찾는다(녹화와 같은 규칙)', async () => {
    const rows: SemanticNode = { ref: '@r0', role: 'root', children: [
      { ref: '@r1', role: 'button', testId: 'com.app:id/row', children: [{ ref: '@r2', role: 'text', text: '뉴스공장' }] },
      { ref: '@r3', role: 'button', testId: 'com.app:id/row', children: [{ ref: '@r4', role: 'text', text: 'florence guerin 영화' }] },
    ] };
    const engine = new FakeEngine({ root: rows, onTap: (n) => (n.ref === '@r3' ? { ref: '@d0', role: 'root', children: [{ ref: '@d1', role: 'text', text: '검색 결과' }] } : undefined) });
    const r = await replayRecording(engine, entry({ start: {}, actions: [{ tool: 'tap', target: { role: 'button', label: 'florence guerin 영화', testId: 'com.app:id/row' }, summary: 'tap' }], end: { anchors: [{ role: 'text', label: '검색 결과' }] } }), { goal });
    expect(r).toMatchObject({ outcome: 'replayed' });
    expect(engine.performed.map((p) => p.ref)).toEqual(['@r3']);
  });

  it('끝 확인을 통과해도 화면이 잠잠해질 때까지 기다린다: 검색 결과처럼 늦게 채워지는 목록이 다 보인 뒤에 끝난다(실기기 YouTube)', async () => {
    // 로그인 직후 머리만 보이고, 관찰 몇 번 뒤에 목록 항목이 채워지는 화면
    const head: SemanticNode = { ref: '@h0', role: 'root', children: [{ ref: '@h1', role: 'text', text: '환영합니다' }, { ref: '@h2', role: 'button', name: '로그아웃' }, { ref: '@h3', role: 'list', testId: 'results' }] };
    const full: SemanticNode = structuredClone(head); full.children![2]!.children = [{ ref: '@h4', role: 'text', text: '결과 하나' }, { ref: '@h5', role: 'text', text: '결과 둘' }];
    const engine = login((n) => (n.name === '로그인' ? head : undefined));
    const observe = engine.observe.bind(engine);
    let scheduled = false;
    // 머리가 처음 보이고 250ms 뒤에 목록이 채워진다(네트워크로 결과를 받는 시간)
    engine.observe = async (o) => { const r = await observe(o); if (!scheduled && JSON.stringify(r.root).includes('@h3')) { scheduled = true; setTimeout(() => engine.setRoot(full), 250); } return r; };
    const r = await replayRecording(engine, entry(), { goal, secrets: secrets(), quietMs: 300 });
    expect(r).toMatchObject({ outcome: 'replayed' });
    expect(JSON.stringify((await engine.observe()).root)).toContain('결과 둘');
  });

  it('끝 anchor 가 끝내 보이지 않으면 diverged(끝 불일치) — 액션은 모두 했다', async () => {
    const r = await replayRecording(login((n) => (n.name === '로그인' ? { ref: '@x0', role: 'root', children: [{ ref: '@x1', role: 'text', text: '비밀번호가 틀립니다' }] } : undefined)), entry(), { goal, secrets: secrets(), endTimeoutMs: 200 });
    expect(r).toMatchObject({ outcome: 'diverged', executed: 3, reason: expect.stringMatching(/끝 화면.*환영합니다/) });
  });

  it('목표에 없는 비밀값 자리표시는 입력하지 않는다(그 액션에서 멈춤)', async () => {
    const r = await replayRecording(login(), entry(), { goal: '아이디 qa 로 로그인', secrets: secrets(), findTimeoutMs: 200 });
    expect(r).toMatchObject({ outcome: 'diverged', executed: 1, reason: expect.stringMatching(/비밀값/) });
  });
});

describe('runAct · 이어받기(recording-cache 03)', () => {
  it('replayedPrefix 를 주면 매 턴 요청에 이어받기 안내(한 액션 요약·멈춘 곳·이유, 다시 하지 말라)가 실리고 Ledger 가 목표 아래에 그린다', async () => {
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: 'ok' } }]);
    const r = await runAct(login(), '로그인', { executor: exec, replayedPrefix: { done: ['type textbox [아이디]'], total: 2, reason: '2/2 tap button "로그인": 대상을 찾지 못함' } });
    expect(r.ok).toBe(true);
    for (const req of exec.requests) expect(req.handOff).toMatch(/1\/2.*type textbox \[아이디\].*찾지 못함.*다시 하지/s);
    expect(renderLedger(exec.requests[0]!).text).toMatch(/^목표: 로그인\n\n↪ .*type textbox/);
  });
});

describe('입력창 라벨(실기기 YouTube: 검색창에 직전 검색어가 남아 있음)', () => {
  it('입력창은 담긴 글자가 달라도 같은 대상이다(이름만 라벨) — 녹화는 빈 칸, 재생 때는 직전 검색어', async () => {
    const box = (text?: string): SemanticNode => ({ ref: '@b0', role: 'root', children: [{ ref: '@b1', role: 'textbox', testId: 'com.app:id/search', placeholder: '검색', ...(text ? { text, value: text } : {}) }] });
    const e: CacheEntry = { schema: CACHE_SCHEMA, createdAt: 'x', recordedBy: {}, start: {}, actions: [{ tool: 'type', target: cacheTargetOf(box().children![0]!), text: 'qa', summary: 'type' }], end: { anchors: [] } };
    expect(e.actions[0]!.target).toEqual({ role: 'textbox', testId: 'com.app:id/search', placeholder: '검색' });
    expect(exactMatches(e.actions[0]!.target!, box('플로렌스 게랭'))).toHaveLength(1);
    expect(cacheTargetOf(box('플로렌스 게랭').children![0]!)).toEqual({ role: 'textbox', testId: 'com.app:id/search', placeholder: '검색' });
  });
});
