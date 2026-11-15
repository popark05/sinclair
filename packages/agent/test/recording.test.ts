// 녹화 캐시(recording-cache 01): 성공한 act 는 실제로 실행한 툴 호출을 의미 기술자로 남긴다 — 재생이 모델 없이 같은 대상을 다시 찾을 수 있게.
import { describe, it, expect } from 'vitest';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { parseCacheEntry, CACHE_SCHEMA, type SemanticNode } from '@sinclair/protocol';
import { runAct, scriptedExecutor, SecretBox, secretPlaceholder, type ToolCall } from '../src/index.ts';

const VALUE = 'Tr0ub4dor&3';
const P = secretPlaceholder('QA_PASSWORD');
const login = () => new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });

describe('runAct · 녹화', () => {
  it('성공하면 실행한 툴 호출만(거부·안전망·done 빼고) 대상 기술자로, 비밀값은 자리표시로, 결과 화면에 새로 나타난 이름 있는 노드를 끝 anchor 로 남긴다', async () => {
    const script: ToolCall[] = [
      { name: 'tap', input: { ref: '@e4', force: 'x' } }, // 스키마 위반: 거부(기록 안 함)
      { name: 'type', input: { ref: '@e2', text: 'qa' } },
      { name: 'type', input: { ref: '@e3', text: P } },
      { name: 'tap', input: { ref: '@e9' } }, // 화면에 없는 ref: 거부
      { name: 'tap', input: { ref: '@e4' } },
      { name: 'done', input: { summary: '환영합니다' } },
    ];
    const r = await runAct(login(), `아이디 qa, 비밀번호 ${P} 로 로그인`, { executor: scriptedExecutor(script), secrets: new SecretBox([['QA_PASSWORD', VALUE]]) });
    expect(r.ok).toBe(true);
    expect(r.recording).toEqual({
      actions: [
        { tool: 'type', target: { role: 'textbox', testId: 'com.app:id/username', placeholder: '아이디' }, text: 'qa', summary: expect.any(String) },
        { tool: 'type', target: { role: 'textbox', testId: 'com.app:id/password', placeholder: '비밀번호' }, text: P, summary: expect.any(String) },
        { tool: 'tap', target: { role: 'button', label: '로그인' }, summary: expect.any(String) },
      ],
      end: { anchors: [{ role: 'text', label: '환영합니다' }, { role: 'button', label: '로그아웃' }] },
    });
    expect(JSON.stringify(r.recording)).not.toContain(VALUE);
    // 러너가 그대로 저장소 항목으로 감쌀 수 있는 모양이다
    expect(parseCacheEntry({ schema: CACHE_SCHEMA, createdAt: 'x', recordedBy: {}, start: {}, ...r.recording! }).ok).toBe(true);
  });

  it('화면을 바꾸지 못한 탭·스크롤은 녹화에서 뺀다 — 이어받기 녹화에 에이전트의 헛탭이 남아 다음 재생이 그 대상을 못 찾고 또 이어받았다(실기 YouTube)', async () => {
    const script: ToolCall[] = [
      { name: 'tap', input: { ref: '@e1' } }, // 제목 글자: 아무 일도 일어나지 않는다
      { name: 'scroll', input: { ref: '@e0', direction: 'down' } }, // 스크롤할 것이 없다
      { name: 'type', input: { ref: '@e2', text: 'qa' } },
      { name: 'tap', input: { ref: '@e4' } },
      { name: 'done', input: { summary: '환영합니다' } },
    ];
    const r = await runAct(login(), '아이디 qa 로 로그인', { executor: scriptedExecutor(script) });
    expect(r.ok).toBe(true);
    expect(r.recording!.actions.map((a) => `${a.tool} ${a.target?.label ?? a.target?.placeholder ?? ''}`)).toEqual(['type 아이디', 'tap 로그인']);
  });

  it('실패한 act 는 녹화를 남기지 않는다', async () => {
    const r = await runAct(login(), '로그인', { executor: scriptedExecutor([{ name: 'tap', input: { ref: '@e5' } }]), maxTurns: 1 });
    expect(r.ok).toBe(false);
    expect(r.recording).toBeUndefined();
  });

  it('끝 anchor 는 숫자가 든 글자(시각·개수처럼 바뀌는 값)와 개인정보로 가려지는 글자를 빼고, 8개까지만', async () => {
    const busy: SemanticNode = { ref: '@h0', role: 'root', children: [
      { ref: '@h1', role: 'text', text: '오후 3:42' },
      { ref: '@h2', role: 'text', text: 'qa@example.com' },
      ...Array.from({ length: 12 }, (_, i) => ({ ref: `@h${i + 3}`, role: 'button', name: `메뉴 ${String.fromCharCode(0xac00 + i)}` })),
    ] };
    const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? busy : undefined) });
    const r = await runAct(engine, '로그인', { executor: scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: 'ok' } }]) });
    const labels = r.recording!.end.anchors.map((a) => a.label);
    expect(labels).toHaveLength(8);
    expect(labels.join()).not.toMatch(/3:42|example/);
  });
});

describe('runAct · 녹화 기술자(실기기 YouTube 에서 찾은 것)', () => {
  const history: SemanticNode = { ref: '@r0', role: 'root', children: [
    { ref: '@r1', role: 'button', testId: 'com.app:id/row', children: [{ ref: '@r2', role: 'text', text: 'florence guerin 영화' }] },
    { ref: '@r3', role: 'button', testId: 'com.app:id/row', children: [{ ref: '@r4', role: 'text', text: '뉴스공장' }] },
  ] };
  const done: SemanticNode = { ref: '@d0', role: 'root', children: [{ ref: '@d1', role: 'text', text: '검색 결과' }] };

  it('이름 없는 대상은 자식 글자로 라벨을 만든다(검색 기록 줄)', async () => {
    const engine = new FakeEngine({ root: history, onTap: (n) => (n.ref === '@r1' ? done : undefined) });
    const r = await runAct(engine, '기록에서 고른다', { executor: scriptedExecutor([{ name: 'tap', input: { ref: '@r1' } }, { name: 'done', input: { summary: 'ok' } }]) });
    expect(r.recording!.actions[0]!.target).toEqual({ role: 'button', label: 'florence guerin 영화', testId: 'com.app:id/row' });
  });

  it('녹화할 때 화면에서 기술자가 정확히 하나로 정해지지 않으면(같은 모양 둘) 그 act 는 녹화하지 않는다', async () => {
    const twins: SemanticNode = { ref: '@t0', role: 'root', children: [{ ref: '@t1', role: 'button', testId: 'com.app:id/x' }, { ref: '@t2', role: 'button', testId: 'com.app:id/x' }] };
    const engine = new FakeEngine({ root: twins, onTap: (n) => (n.ref === '@t1' ? done : undefined) });
    const r = await runAct(engine, '아무거나', { executor: scriptedExecutor([{ name: 'tap', input: { ref: '@t1' } }, { name: 'done', input: { summary: 'ok' } }]) });
    expect(r.ok).toBe(true);
    expect(r.recording).toBeUndefined();
  });

  it('anchorsFrom 을 주면 끝 anchor 를 그 화면 기준으로 계산한다(이어받은 act — 재생 시작 화면)', async () => {
    const engine = new FakeEngine({ root: done });
    const r = await runAct(engine, '이미 결과 화면', { executor: scriptedExecutor([{ name: 'done', input: { summary: 'ok' } }]), anchorsFrom: history });
    expect(r.recording!.end.anchors).toEqual([{ role: 'text', label: '검색 결과' }]);
  });
});
