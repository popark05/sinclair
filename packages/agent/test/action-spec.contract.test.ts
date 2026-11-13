// 닫힌 툴 계약: 하나의 action spec 에서 모델용 스키마와 실행이 함께 나온다. 검사기는 스키마와 같은 판단을 한다.
import { describe, it, expect } from 'vitest';
import { ACTIONS, toolSchemas, checkToolCall } from '../src/index.ts';

describe('action spec', () => {
  it('툴 여섯(tap·type·submit·scroll·back·done) 모두 설명·인자 스키마·실행을 가진다', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(['back', 'done', 'scroll', 'submit', 'tap', 'type']);
    for (const [name, a] of Object.entries(ACTIONS)) {
      expect(a.description, name).toMatch(/\S/);
      expect(typeof a.run, name).toBe('function');
    }
  });

  it('모델용 스키마는 spec 에서 만들어진다: 이름·설명·닫힌 JSON 스키마(추가 속성 금지, 필수 인자)', () => {
    const schemas = toolSchemas();
    expect(schemas.map((s) => s.name).sort()).toEqual(Object.keys(ACTIONS).sort());
    const type = schemas.find((s) => s.name === 'type')!;
    expect(type.input_schema).toEqual({
      type: 'object', additionalProperties: false, required: ['ref', 'text'],
      properties: { ref: { type: 'string', description: expect.any(String) }, text: { type: 'string', description: expect.any(String) } },
    });
    const scroll = schemas.find((s) => s.name === 'scroll')!;
    expect(scroll.input_schema.properties.direction).toMatchObject({ type: 'string', enum: ['up', 'down'] });
    expect(schemas.find((s) => s.name === 'back')!.input_schema).toMatchObject({ required: [], properties: {} });
    // 입력 확정(키보드의 검색·완료·Enter): 실행 키가 화면이 아니라 키보드에만 있는 앱(YouTube 검색 등)을 위해
    expect(schemas.find((s) => s.name === 'submit')!.input_schema).toEqual({ type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: { type: 'string', description: expect.any(String) } } });
  });

  it('submit 은 그 입력란에서 Enter 를 누른다(엔진 press)', async () => {
    const calls: unknown[][] = [];
    const engine = { perform: async (...a: unknown[]) => { calls.push(a); } } as unknown as Parameters<typeof ACTIONS.submit.run>[0];
    await ACTIONS.submit.run(engine, { ref: '@e21' });
    expect(calls).toEqual([['@e21', 'press', 'Enter']]);
  });

  it('검사기는 스키마와 같은 판단: 모르는 툴·빠진 인자·모르는 인자·틀린 타입·enum 밖 값을 거부한다', () => {
    expect(checkToolCall({ name: 'tap', input: { ref: '@e4' } })).toEqual({ ok: true, call: { name: 'tap', input: { ref: '@e4' } } });
    expect(checkToolCall({ name: 'rm', input: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/모르는 툴/) });
    expect(checkToolCall({ name: 'type', input: { ref: '@e2' } })).toMatchObject({ ok: false, error: expect.stringMatching(/text/) });
    expect(checkToolCall({ name: 'tap', input: { ref: '@e4', force: true } })).toMatchObject({ ok: false, error: expect.stringMatching(/force/) });
    expect(checkToolCall({ name: 'tap', input: { ref: 4 } })).toMatchObject({ ok: false, error: expect.stringMatching(/ref/) });
    expect(checkToolCall({ name: 'scroll', input: { ref: '@e1', direction: 'left' } })).toMatchObject({ ok: false, error: expect.stringMatching(/direction/) });
    expect(checkToolCall({ name: 'tap', input: 'x' })).toMatchObject({ ok: false });
    // 스키마의 required 와 검사기가 같은 목록을 본다(어긋나면 이 반복이 잡는다)
    for (const s of toolSchemas()) for (const req of s.input_schema.required) {
      const input = Object.fromEntries(s.input_schema.required.filter((r) => r !== req).map((r) => [r, s.input_schema.properties[r]!.enum?.[0] ?? 'x']));
      expect(checkToolCall({ name: s.name, input }).ok, `${s.name} 에서 ${req} 가 빠짐`).toBe(false);
    }
  });

  it('모든 툴에 대해: 모르는 인자는 거부, enum 밖 값은 거부, 올바른 인자는 통과(스키마에서 만든 입력으로)', () => {
    for (const s of toolSchemas()) {
      const good = Object.fromEntries(Object.entries(s.input_schema.properties).map(([k, p]) => [k, p.enum?.[0] ?? 'x']));
      expect(checkToolCall({ name: s.name, input: good }).ok, `${s.name} 올바른 입력`).toBe(true);
      expect(checkToolCall({ name: s.name, input: { ...good, extra: 'x' } }).ok, `${s.name} 추가 인자`).toBe(false);
      for (const [k, p] of Object.entries(s.input_schema.properties)) if (p.enum) expect(checkToolCall({ name: s.name, input: { ...good, [k]: 'not-in-enum' } }).ok, `${s.name}.${k} enum`).toBe(false);
    }
  });

  it('스키마는 매번 새 객체라 고쳐도 spec 이 바뀌지 않고, __proto__ 같은 키도 거부한다', () => {
    const a = toolSchemas();
    a[0]!.input_schema.required.push('hacked');
    expect(toolSchemas()[0]!.input_schema.required).not.toContain('hacked');
    expect(checkToolCall({ name: '__proto__', input: {} }).ok).toBe(false);
    expect(checkToolCall({ name: 'tap', input: JSON.parse('{"ref":"@e1","__proto__":{"x":1}}') }).ok).toBe(false);
  });
});

