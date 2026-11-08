// 타깃 선택 조건 계약: Cycle 의 타깃은 이름(문자열, 노드가 선언) 또는 조건(플랫폼·모델·OS 범위). 닫힌 검증기와 기기 매칭.
import { describe, it, expect } from 'vitest';
import { parseCycleTargets, matchesTarget, compareOsVersion, type NodeDevice } from '../src/index.ts';

const dev = (over: Partial<NodeDevice> = {}): NodeDevice => ({ id: 'S1', platform: 'android', model: 'SM-N981N', osVersion: '13', connection: 'device', helper: 'ready', locked: false, ...over });

describe('parseCycleTargets', () => {
  it('문자열과 조건을 섞어 받고, 조건은 id 로 정규화한다', () => {
    const r = parseCycleTargets(['android', { id: 'a13', platform: 'android', osVersion: { min: '13' } }, { id: 'note20', platform: 'android', model: ['SM-N981N', 'SM-N986N'] }]);
    expect(r).toEqual({ ok: true, ids: ['android', 'a13', 'note20'], selectors: { a13: { id: 'a13', platform: 'android', osVersion: { min: '13' } }, note20: { id: 'note20', platform: 'android', model: ['SM-N981N', 'SM-N986N'] } } });
  });
  it('잘못된 조건은 경로와 함께 거부한다', () => {
    const r = parseCycleTargets([{ id: '', platform: 'windows', model: 3, osVersion: { min: 'x', max: '12', extra: 1 }, color: 'red' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/targets\[0\]\.id/), expect.stringMatching(/targets\[0\]\.platform/), expect.stringMatching(/targets\[0\]\.model/),
      expect.stringMatching(/targets\[0\]\.osVersion\.min/), expect.stringMatching(/targets\[0\]\.osVersion\.extra/), expect.stringMatching(/targets\[0\]\.color/),
    ]));
  });
  it('같은 이름 문자열이 두 번이면 하나로 합친다(하위 호환)', () => {
    expect(parseCycleTargets(['android', 'ios', 'android'])).toEqual({ ok: true, ids: ['android', 'ios'], selectors: {} });
  });
  it('빈 목록·조건이 낀 같은 id 두 번·min > max 는 거부', () => {
    expect(parseCycleTargets([]).ok).toBe(false);
    expect(parseCycleTargets(['a', { id: 'a', platform: 'android' }]).ok).toBe(false);
    expect(parseCycleTargets([{ id: 'a', platform: 'android' }, 'a']).ok).toBe(false);
    expect(parseCycleTargets([{ id: 'r', platform: 'android', osVersion: { min: '14', max: '13' } }]).ok).toBe(false);
    expect(parseCycleTargets('android').ok).toBe(false);
    expect(parseCycleTargets([{ id: 'e', platform: 'android', osVersion: {} }]).ok).toBe(false); // 빈 범위
    expect(parseCycleTargets([{ id: 'm', platform: 'android', model: [] }]).ok).toBe(false); // 빈 모델 목록
  });
});

describe('compareOsVersion', () => {
  it('점으로 나눈 숫자로 비교한다(빈 자리는 0)', () => {
    expect(compareOsVersion('13', '13.0')).toBe(0);
    expect(compareOsVersion('13', '13.1')).toBeLessThan(0);
    expect(compareOsVersion('9', '13')).toBeLessThan(0); // 문자열 비교면 반대
    expect(compareOsVersion('14.0.1', '14')).toBeGreaterThan(0);
  });
});

describe('matchesTarget', () => {
  it('플랫폼·모델(하나 또는 목록)·OS 범위(포함)를 모두 만족해야 맞는다', () => {
    expect(matchesTarget(dev(), { id: 't', platform: 'android' })).toBe(true);
    expect(matchesTarget(dev(), { id: 't', platform: 'ios' })).toBe(false);
    expect(matchesTarget(dev(), { id: 't', platform: 'android', model: 'SM-N981N' })).toBe(true);
    expect(matchesTarget(dev(), { id: 't', platform: 'android', model: ['Pixel 7', 'SM-N981N'] })).toBe(true);
    expect(matchesTarget(dev(), { id: 't', platform: 'android', model: 'Pixel 7' })).toBe(false);
    expect(matchesTarget(dev({ osVersion: '13' }), { id: 't', platform: 'android', osVersion: { min: '13' } })).toBe(true);
    expect(matchesTarget(dev({ osVersion: '12' }), { id: 't', platform: 'android', osVersion: { min: '13' } })).toBe(false);
    expect(matchesTarget(dev({ osVersion: '14' }), { id: 't', platform: 'android', osVersion: { min: '13', max: '13' } })).toBe(false);
    expect(matchesTarget(dev({ osVersion: '13.1' }), { id: 't', platform: 'android', osVersion: { max: '13' } })).toBe(false);
  });
  it('OS 버전을 숫자로 읽을 수 없는 기기는 OS 조건이 있으면 맞지 않는다', () => {
    expect(matchesTarget(dev({ osVersion: 'Baklava' }), { id: 't', platform: 'android', osVersion: { min: '13' } })).toBe(false);
    expect(matchesTarget(dev({ osVersion: 'Baklava' }), { id: 't', platform: 'android' })).toBe(true);
  });
});
