// 닫힌 툴 계약: 하나의 action spec 에서 모델용 스키마와 실행이 함께 나온다. 검사기는 스키마와 같은 판단을 한다.
import { describe, it, expect } from 'vitest';
import { ACTIONS, toolSchemas, checkToolCall } from '../src/index.ts';

describe('action spec', () => {
  it('툴 다섯(tap·type·scroll·back·done) 모두 설명·인자 스키마·실행을 가진다', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(['back', 'done', 'scroll', 'tap', 'type']);
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
});
