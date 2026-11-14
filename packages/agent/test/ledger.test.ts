// Ledger: 목표(항상 전체)·오래된 턴 요약(8턴 묶음)·최근 턴 전체·현재 관찰. 예산을 넘으면 정해진 순서로 줄인다.
import { describe, it, expect } from 'vitest';
import type { SemanticNode } from '@sinclair/protocol';
import { FakeEngine, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { estimateTokens, renderLedger, screenChange, runAct, scriptedExecutor, LEDGER_BLOCK, type AgentTurn, type StepRequest } from '../src/index.ts';

const turn = (i: number, extra: Partial<AgentTurn> = {}): AgentTurn => ({ call: { name: 'tap', input: { ref: `@e${i}` } }, result: i % 7 === 0 ? 'error' : 'ok', ...(i % 7 === 0 ? { detail: `not-found: 노드 @e${i} 가 없음 ${'자세한 사유 '.repeat(20)}` } : {}), ...extra });
const req = (n: number, observation = '@e0 root\n  @e1 button "다음"', goal = '설정에서 알림을 끄고 돌아와라'): StepRequest => ({ goal, observation, history: Array.from({ length: n }, (_, i) => turn(i + 1)), tools: [] });

describe('estimateTokens', () => {
  it('한글은 글자당 1.35(실측 약 1.15), 영문 글자는 2.5자당 1, 숫자·기호는 1.8자당 1, 10% 여유(countTokens 실측보다 크게)', () => {
    expect(estimateTokens('가나다')).toBe(5); // 3 × 1.35 × 1.1
    expect(estimateTokens('abcde')).toBe(3); // 5/2.5 × 1.1
    expect(estimateTokens('@123')).toBe(3); // 4/1.8 × 1.1
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
  }, 30_000); // 턴 50개 × 매 턴 예산 맞추기 — CPU 집약이라 전체 실행 부하에서 기본 5초를 넘기기도 한다

  it('줄이는 순서: 사유 문구 자르기 → 최근 턴 줄이기(최소 3) → 관찰 자르기', () => {
    const full = renderLedger(req(14));
    expect(full.text).toMatch(/(자세한 사유 ){15}/);
    const r1 = renderLedger(req(14), { budgetTokens: 500 }); // 사유만 자르면 들어간다
    expect(r1).toMatchObject({ recentTurns: 14, truncatedObservation: false });
    expect(r1.text).not.toMatch(/(자세한 사유 ){15}/);
    const r2 = renderLedger(req(14), { budgetTokens: 380 }); // 최근 턴도 줄여야 들어간다
    expect(r2.recentTurns).toBeLessThan(14);
    expect(r2.recentTurns).toBeGreaterThanOrEqual(3);
    expect(r2.truncatedObservation).toBe(false);
    expect(r2.estimatedTokens).toBeLessThanOrEqual(380);
  });

  it('모델 요약이 주어지면 그 묶음은 모델 요약으로', () => {
    const r = renderLedger(req(20), { blockSummary: (from) => (from === 1 ? '설정 앱을 열고 알림 메뉴까지 갔다' : undefined) });
    expect(r.text).toMatch(/턴 1–8 요약\(요약 모델, 참고용\): 설정 앱을 열고 알림 메뉴까지 갔다/);
  });
});

describe('screenChange', () => {
  const s = (...labels: string[]): SemanticNode => ({ ref: '@r', role: 'root', children: labels.map((l, i) => ({ ref: `@${i}`, role: 'text', text: l })) });
  it('나타난 글자·사라진 글자를 한 줄로(같으면 없음)', () => {
    expect(screenChange(s('로그인', '아이디'), s('환영합니다', '로그아웃', '아이디'))).toBe('+ "환영합니다" "로그아웃" / − "로그인"');
    expect(screenChange(s('a'), s('a'))).toBeUndefined();
    expect(screenChange(s(...Array.from({ length: 30 }, (_, i) => `항목 ${String.fromCharCode(0xac00 + i)}`)), s())).toMatch(/− .* 외 25개/);
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

describe('Ledger · 리뷰 반영(예산 보장·변화 잡음·상태)', () => {
  const turns = (n: number): AgentTurn[] => Array.from({ length: n }, (_, i) => ({ call: { name: 'tap', input: { ref: `@e${i + 1}` } }, result: 'ok' }));
  it.each([
    ['아주 긴 목표', { goal: '긴 목표 '.repeat(3000), observation: '@r root', history: turns(3), tools: [] }],
    ['아주 긴 Incident', { goal: 'g', incident: 'Incident: '.repeat(2000), observation: '@r root', history: turns(3), tools: [] }],
    ['아주 긴 루트 한 줄', { goal: 'g', observation: `@r root "${'x'.repeat(40000)}"`, history: turns(3), tools: [] }],
    ['턴 200개 + 긴 모델 요약', { goal: 'g', observation: '@r root', history: turns(200), tools: [] }],
  ] as Array<[string, StepRequest]>)('%s 도 예산을 넘지 않고, 마지막 3턴은 남는다', (_, r) => {
    for (const budget of [1000, 4000]) {
      const l = renderLedger(r, { budgetTokens: budget, blockSummary: () => '요'.repeat(400) });
      expect(l.estimatedTokens).toBeLessThanOrEqual(budget);
      const n = r.history.length;
      for (let i = n - 2; i <= n; i++) expect(l.text).toMatch(new RegExp(`^${i}\\. tap @e${i} `, 'm'));
    }
  });

  it('긴 목표는 앞부분을 남기고 잘렸다고 표시한다', () => {
    const l = renderLedger({ goal: `핵심 목표 ${'부연 '.repeat(4000)}`, observation: '@r root', history: [], tools: [] }, { budgetTokens: 2000 });
    expect(l.text).toMatch(/^목표: 핵심 목표 /);
    expect(l.text).toMatch(/목표 \d+자 생략/);
  });

  it('추정은 영문·한글·트리 문법 모두 넉넉하게(바이트/3 보다 크거나 같다)', () => {
    for (const t of ['가나다라', 'hello world', '@e123 button "결제" id=com.app:id/pay (disabled)']) expect(estimateTokens(t)).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(t) / 3));
    expect(estimateTokens('@e123')).toBeGreaterThanOrEqual(3);
  });
});

describe('screenChange · 리뷰 반영', () => {
  const s = (nodes: SemanticNode[]): SemanticNode => ({ ref: '@r', role: 'root', children: nodes });
  it('숫자만 바뀌는 글자(시계·배터리)는 변화가 아니다', () => {
    expect(screenChange(s([{ ref: '@c', role: 'text', text: '10:30' }, { ref: '@b', role: 'text', text: '배터리 81%' }]), s([{ ref: '@c', role: 'text', text: '10:31' }, { ref: '@b', role: 'text', text: '배터리 80%' }]))).toBeUndefined();
  });
  it('스위치·체크 상태 변화를 알린다', () => {
    const sw = (checked: boolean): SemanticNode => s([{ ref: '@s', role: 'switch', name: '알림', states: { checked } }]);
    expect(screenChange(sw(true), sw(false))).toBe('~ "알림" 선택 해제');
    expect(screenChange(sw(false), sw(true))).toBe('~ "알림" 선택됨');
  });
  it('입력 칸의 글자(입력한 값)는 변화로 내보내지 않는다', () => {
    expect(screenChange(s([{ ref: '@f', role: 'textbox', placeholder: '아이디' }]), s([{ ref: '@f', role: 'textbox', placeholder: '아이디', text: 'qa-plain' }]))).toBeUndefined();
  });
});
