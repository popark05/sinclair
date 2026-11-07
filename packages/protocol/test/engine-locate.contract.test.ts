// 엔진 계약: 오류 코드와 locate 매칭 규칙. FakeEngine 과 engine-mobile 이 같은 locateInTree 를 쓴다.
import { describe, it, expect } from 'vitest';
import { ENGINE_ERROR_CODES, EngineError, locateInTree, type SemanticNode } from '../src/index.ts';

const tree: SemanticNode = {
  ref: '@e0', role: 'root', children: [
    { ref: '@e1', role: 'group', testId: 'com.app:id/header', children: [
      { ref: '@e2', role: 'text', text: 'Sinclair 로그인' },
      { ref: '@e3', role: 'button', name: '로그인' },
    ] },
    { ref: '@e4', role: 'textbox', testId: 'com.app:id/username', placeholder: '아이디', value: 'popark' },
    { ref: '@e5', role: 'textbox', testId: 'com.app:id/password', placeholder: '비밀번호', value: 'hunter2', text: 'hunter2', states: { secure: true } },
    { ref: '@e6', role: 'button', name: '로그인', states: { disabled: true } },
    { ref: '@e7', role: 'button', name: '회원가입' },
  ],
};

describe('엔진 오류 코드 계약', () => {
  it('코드 목록은 spec 과 같고 EngineError 는 code 와 details 를 가진다', () => {
    expect(ENGINE_ERROR_CODES).toEqual(['not-found', 'ambiguous', 'not-actionable', 'secure-read', 'unsupported-action', 'timeout', 'engine-closed', 'device-unavailable', 'device-error']);
    const e = new EngineError('not-found', '찾을 수 없음', { query: { role: 'button' } });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('not-found');
    expect(e.details).toEqual({ query: { role: 'button' } });
  });
});

describe('locateInTree 매칭 규칙', () => {
  it('role 은 정확 일치, name/text 문자열은 대소문자 무시 부분 일치, 정규식은 정규식', () => {
    expect(locateInTree(tree, { role: 'button' }).map((n) => n.ref)).toEqual(['@e3', '@e6', '@e7']);
    expect(locateInTree(tree, { role: 'but' })).toEqual([]);
    expect(locateInTree(tree, { role: 'button', name: '로그' }).map((n) => n.ref)).toEqual(['@e3', '@e6']);
    expect(locateInTree(tree, { text: 'sinclair' }).map((n) => n.ref)).toEqual(['@e2']);
    expect(locateInTree(tree, { name: /^회원/ }).map((n) => n.ref)).toEqual(['@e7']);
  });

  it('testId 와 placeholder 는 정확 일치이며 testId 는 resource-id 의 짧은 이름으로도 맞는다', () => {
    expect(locateInTree(tree, { testId: 'com.app:id/username' }).map((n) => n.ref)).toEqual(['@e4']);
    expect(locateInTree(tree, { testId: 'username' }).map((n) => n.ref)).toEqual(['@e4']);
    expect(locateInTree(tree, { testId: 'user' })).toEqual([]);
    expect(locateInTree(tree, { placeholder: '아이디' }).map((n) => n.ref)).toEqual(['@e4']);
    expect(locateInTree(tree, { placeholder: '아이' })).toEqual([]);
  });

  it('within 은 그 조상 아래로 제한하고 nth 는 문서 순서다', () => {
    expect(locateInTree(tree, { role: 'button', within: '@e1' }).map((n) => n.ref)).toEqual(['@e3']);
    expect(locateInTree(tree, { role: 'button', within: '@e999' })).toEqual([]);
    expect(locateInTree(tree, { role: 'button', nth: 1 }).map((n) => n.ref)).toEqual(['@e6']);
    expect(locateInTree(tree, { role: 'button', nth: 5 })).toEqual([]);
  });

  it('exact 는 name/text 문자열을 대소문자 구분 정확 일치로 바꾸고 정규식에는 영향이 없다', () => {
    expect(locateInTree(tree, { role: 'button', name: '로그인', exact: true }).map((n) => n.ref)).toEqual(['@e3', '@e6']);
    expect(locateInTree(tree, { role: 'button', name: '로그', exact: true })).toEqual([]);
    expect(locateInTree(tree, { text: 'sinclair', exact: true })).toEqual([]);
    expect(locateInTree(tree, { text: /sinclair/i, exact: true }).map((n) => n.ref)).toEqual(['@e2']);
  });

  it('within 뒤에 nth 가 적용되고, g 플래그 정규식도 노드마다 새로 검사한다', () => {
    expect(locateInTree(tree, { role: 'button', within: '@e0', nth: 2 }).map((n) => n.ref)).toEqual(['@e7']);
    const sticky = /로그/g;
    expect(locateInTree(tree, { name: sticky }).map((n) => n.ref)).toEqual(['@e3', '@e6']);
    expect(locateInTree(tree, { name: sticky }).map((n) => n.ref)).toEqual(['@e3', '@e6']);
  });

  it('secure 노드는 찾을 수는 있지만 text/value 가 제거된 채 돌아온다', () => {
    const [pw] = locateInTree(tree, { testId: 'password' });
    expect(pw).toMatchObject({ ref: '@e5', role: 'textbox', placeholder: '비밀번호', states: { secure: true } });
    expect(pw).not.toHaveProperty('value');
    expect(pw).not.toHaveProperty('text');
  });

  it('결과 노드는 children 을 포함하지 않는다(위치 결과이지 부분 트리가 아니다)', () => {
    const [header] = locateInTree(tree, { testId: 'header' });
    expect(header).not.toHaveProperty('children');
  });
});
