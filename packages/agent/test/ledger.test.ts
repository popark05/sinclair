// Ledger: 목표(항상 전체)·오래된 턴 요약(8턴 묶음)·최근 턴 전체·현재 관찰. 예산을 넘으면 정해진 순서로 줄인다.
import { describe, it, expect } from 'vitest';
import type { SemanticNode } from '@sinclair/protocol';
import { FakeEngine, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { estimateTokens, renderLedger, screenChange, runAct, scriptedExecutor, LEDGER_BLOCK, type AgentTurn, type StepRequest } from '../src/index.ts';

const turn = (i: number, extra: Partial<AgentTurn> = {}): AgentTurn => ({ call: { name: 'tap', input: { ref: `@e${i}` } }, result: i % 7 === 0 ? 'error' : 'ok', ...(i % 7 === 0 ? { detail: `not-found: 노드 @e${i} 가 없음 ${'자세한 사유 '.repeat(20)}` } : {}), ...extra });
const req = (n: number, observation = '@e0 root\n  @e1 button "다음"', goal = '설정에서 알림을 끄고 돌아와라'): StepRequest => ({ goal, observation, history: Array.from({ length: n }, (_, i) => turn(i + 1)), tools: [] });

describe('estimateTokens', () => {
  it('UTF-8 바이트/3 — 한글은 글자당 1, 영문은 3자당 1(보수적)', () => {
    expect(estimateTokens('가나다')).toBe(3);
    expect(estimateTokens('abcdef')).toBe(2);
  });
});

describe('renderLedger', () => {
  it('짧은 세션은 모든 턴을 그대로 싣고 접지 않는다', () => {
    const r = renderLedger(req(5));
    expect(r.foldedTurns).toBe(0);
    for (let i = 1; i <= 5; i++) expect(r.text).toContain(`${i}. tap @e${i}`);
    expect(r.text).toMatch(/목표: 설정에서 알림을 끄고 돌아와라/);
  });

  it('오래된 턴은 8턴 묶음으로 결정적 요약에 접힌다(툴·결과 집계, 마지막 오류)', () => {
    const r = renderLedger(req(20));
    expect(r.foldedTurns).toBe(LEDGER_BLOCK); // 20 - 8 = 12 → 한 묶음(8)만 접고 나머지 12턴은 그대로
    expect(r.text).toMatch(/턴 1–8 요약: tap 8\(ok 7, error 1\)/);
    expect(r.text).toMatch(/마지막 오류: 7\. tap @e7/);
    expect(r.text).not.toMatch(/^1\. tap @e1 /m);
    expect(r.text).toContain('20. tap @e20');
  });

  it('턴 50개·큰 화면에서도 매번 예산 이하이고 목표와 마지막 3턴은 늘 들어 있다', () => {
    const big = Array.from({ length: 900 }, (_, i) => `  @n${i} ${i % 3 ? 'text' : 'button'} "항목 ${i} ${'설명 '.repeat(4)}"`).join('\n');
    for (let n = 1; n <= 50; n++) {
      const r = renderLedger(req(n, `@r root\n${big}`), { budgetTokens: 4000 });
      expect(r.estimatedTokens).toBeLessThanOrEqual(4000);
      expect(r.text).toContain('목표: 설정에서 알림을 끄고 돌아와라');
      for (let i = Math.max(1, n - 2); i <= n; i++) expect(r.text).toContain(`${i}. tap @e${i}`);
    }
    const last = renderLedger(req(50, `@r root\n${big}`), { budgetTokens: 4000 });
    expect(last.truncatedObservation).toBe(true);
    expect(last.text).toMatch(/줄 생략/);
    expect(last.text).toMatch(/@n0 button/); // 누를 수 있는 노드를 먼저 남긴다
  });

  it('줄이는 순서: 사유 문구 자르기 → 최근 턴 줄이기(최소 3) → 관찰 자르기', () => {
    const full = renderLedger(req(14));
    expect(full.text).toMatch(/(자세한 사유 ){15}/);
    const r1 = renderLedger(req(14), { budgetTokens: 300 }); // 사유만 자르면 들어간다
    expect(r1).toMatchObject({ recentTurns: 14, truncatedObservation: false });
    expect(r1.text).not.toMatch(/(자세한 사유 ){15}/);
    const r2 = renderLedger(req(14), { budgetTokens: 250 }); // 최근 턴도 줄여야 들어간다
    expect(r2.recentTurns).toBeLessThan(14);
    expect(r2.recentTurns).toBeGreaterThanOrEqual(3);
    expect(r2.truncatedObservation).toBe(false);
    expect(r2.estimatedTokens).toBeLessThanOrEqual(250);
  });

  it('모델 요약이 주어지면 그 묶음은 모델 요약으로', () => {
    const r = renderLedger(req(20), { blockSummary: (from) => (from === 1 ? '설정 앱을 열고 알림 메뉴까지 갔다' : undefined) });
    expect(r.text).toMatch(/턴 1–8 요약: 설정 앱을 열고 알림 메뉴까지 갔다/);
  });
});

describe('screenChange', () => {
  const s = (...labels: string[]): SemanticNode => ({ ref: '@r', role: 'root', children: labels.map((l, i) => ({ ref: `@${i}`, role: 'text', text: l })) });
  it('나타난 글자·사라진 글자를 한 줄로(같으면 없음)', () => {
    expect(screenChange(s('로그인', '아이디'), s('환영합니다', '로그아웃', '아이디'))).toBe('+ "환영합니다" "로그아웃" / − "로그인"');
    expect(screenChange(s('a'), s('a'))).toBeUndefined();
    expect(screenChange(s(...Array.from({ length: 30 }, (_, i) => `x${i}`)), s())).toMatch(/− .* 외 25개/);
  });
});

describe('Ledger · 대본 모델 50턴 세션', () => {
  it('runAct 의 매 요청을 Ledger 로 그리면 예산 이하이고, 목표와 마지막 3턴이 늘 있다', async () => {
    const goal = '목록 끝까지 내려가 "더 보기" 를 찾아라';
    const exec = scriptedExecutor((_req, i) => (i < 50 ? (i % 5 === 4 ? { name: 'tap', input: { ref: '@없음' } } : { name: 'scroll', input: { ref: '@e0', direction: 'down' } }) : { name: 'done', input: { summary: 'x' } }));
    const r = await runAct(new FakeEngine({ root: LOGIN_SCREEN }), goal, { executor: exec, maxTurns: 60 });
    expect(r.ok).toBe(true);
    expect(exec.requests).toHaveLength(51);
    for (const req of exec.requests) {
      const l = renderLedger(req, { budgetTokens: 1500 });
      expect(l.estimatedTokens).toBeLessThanOrEqual(1500);
      expect(l.text).toContain(`목표: ${goal}`);
      const n = req.history.length;
      for (let i = Math.max(0, n - 3); i < n; i++) expect(l.text).toContain(`${i + 1}. ${req.history[i]!.call!.name}`);
    }
  });
});
