// 화면 개인정보 가림: 패턴(이메일·전화번호·주민등록번호·카드번호·IMEI)과 사람이 준 목록을 종류 자리표시로. 거짓 양성(버전·날짜·금액)은 그대로.
import { describe, it, expect } from 'vitest';
import { FakeEngine } from '@sinclair/protocol/testing';
import type { SemanticNode } from '@sinclair/protocol';
import { createPiiFilter, runAct, judgeAssert, scriptedExecutor, type StepExecutor } from '../src/index.ts';

const pii = createPiiFilter();

describe('createPiiFilter · 패턴', () => {
  it.each([
    ['삼성 계정  •  qa*****@example.com', '삼성 계정  •  <이메일>'],
    ['문의 qa.team+1@hyundai-autoever.com 으로', '문의 <이메일> 으로'],
    ['전화 010-1234-5678', '전화 <전화번호>'],
    ['01012345678 로 인증', '<전화번호> 로 인증'],
    ['대표 02-123-4567', '대표 <전화번호>'],
    ['국제 +82 10-1234-5678', '국제 <전화번호>'],
    ['주민번호 900101-1234567', '주민번호 <주민등록번호>'],
    ['카드 4111 1111 1111 1111', '카드 <카드번호>'],
    ['카드 4111-1111-1111-1111', '카드 <카드번호>'],
    ['IMEI 490154203237518', 'IMEI <IMEI>'],
  ])('%j → %j', (input, want) => {
    expect(pii.redact(input)).toBe(want);
  });

  it.each([
    'Android 버전 13', '빌드 번호 TP1A.220624.014.N981NKSU4HXA1', '2026-11-09 10:30', '해상도 1080 x 2400', '합계 12,300원', 'One UI 5.1', '배터리 81%',
    '4111 1111 1111 1112', // 룬 검사 실패 — 카드번호가 아니다
    '1234567890', // 10자리 숫자(주문번호 등)는 전화번호 모양이 아니다
  ])('거짓 양성 아님: %j', (text) => {
    expect(pii.redact(text)).toBe(text);
  });

  it('목록의 이름·계정명도 가리고, 끄면 그대로', () => {
    const f = createPiiFilter({ terms: ['홍길동', 'QA Tester'] });
    expect(f.redact('홍길동 님의 기기 / QA Tester')).toBe('<개인정보> 님의 기기 / <개인정보>');
    expect(createPiiFilter({ enabled: false }).redact('010-1234-5678')).toBe('010-1234-5678');
  });

  it('구조적: 트리 문자열 잎만 바꾸고 숫자·키는 그대로', () => {
    const tree: SemanticNode = { ref: '@r', role: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [{ ref: '@a', role: 'text', text: 'qa*****@example.com' }] };
    expect(pii.redactTree(tree)).toEqual({ ...tree, children: [{ ref: '@a', role: 'text', text: '<이메일>' }] });
  });
});

describe('모델 요청에 개인정보가 없다', () => {
  const screen: SemanticNode = { ref: '@r', role: 'root', children: [
    { ref: '@e1', role: 'button', name: '계정', children: [{ ref: '@e2', role: 'text', text: '홍길동' }, { ref: '@e3', role: 'text', text: '삼성 계정  •  qa*****@example.com' }] },
    { ref: '@e4', role: 'button', name: '휴대전화 정보' },
  ] };

  it('act 의 관찰(기본 켜짐)과 판정 관찰에서 가린다; 목록을 주면 이름도', async () => {
    const exec = scriptedExecutor([{ name: 'tap', input: { ref: '@e4' } }, { name: 'done', input: { summary: 'x' } }]);
    await runAct(new FakeEngine({ root: screen }), '휴대전화 정보 열기', { executor: exec, pii: createPiiFilter({ terms: ['홍길동'] }) });
    const sent = JSON.stringify(exec.requests);
    expect(sent).not.toContain('example.com');
    expect(sent).not.toContain('홍길동');
    expect(sent).toContain('<이메일>');
    const byDefault = scriptedExecutor([{ name: 'done', input: { summary: 'x' } }]);
    await runAct(new FakeEngine({ root: screen }), '목표', { executor: byDefault });
    expect(JSON.stringify(byDefault.requests)).not.toContain('example.com');
    const judged: string[] = [];
    const judge: StepExecutor = { next: () => Promise.reject(new Error('x')), judge: async (req) => { judged.push(JSON.stringify(req)); return { answer: { pass: true, reason: 'ok' } }; } };
    await judgeAssert(new FakeEngine({ root: screen }), '계정 행이 있다', { executor: judge });
    expect(judged[0]).not.toContain('example.com');
  });

  it('pii: false 면 끈다', async () => {
    const exec = scriptedExecutor([{ name: 'done', input: { summary: 'x' } }]);
    await runAct(new FakeEngine({ root: screen }), '목표', { executor: exec, pii: false });
    expect(JSON.stringify(exec.requests)).toContain('example.com');
  });
});
