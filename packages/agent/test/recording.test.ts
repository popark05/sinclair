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
