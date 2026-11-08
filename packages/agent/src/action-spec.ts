// 닫힌 툴 집합의 단일 원천: 툴마다 설명·인자·엔진 실행을 한 곳에 둔다. 모델에 주는 JSON 스키마(toolSchemas)와
// 실행 전 검사기(checkToolCall)와 실행(run)이 모두 이 표에서 나오므로 셋이 어긋날 수 없다(계약 테스트가 지킨다).
import { EngineError, type Engine } from '@sinclair/protocol';

/** 인자 하나의 모양. 지금은 문자열뿐(enum 으로 값 제한) — 툴이 늘면 여기에 타입을 더한다 */
export interface ParamSpec { type: 'string'; description: string; enum?: readonly string[] }

export interface ActionSpec {
  description: string;
  params: Record<string, ParamSpec>;
  /** 엔진에 실행한다. done 처럼 화면을 건드리지 않는 툴은 아무것도 하지 않는다 */
  run(engine: Engine, input: Record<string, string>): Promise<void>;
  /** 루프를 끝내는 툴(성공) */
  terminal?: boolean;
}

const ref: ParamSpec = { type: 'string', description: '대상 노드의 ref(관찰에 나온 @로 시작하는 값)' };

export const ACTIONS = {
  tap: {
    description: '노드 하나를 탭한다(버튼·링크·항목 선택).',
    params: { ref },
    run: (engine, { ref: r }) => engine.perform(r!, 'tap'),
  },
  type: {
    description: '입력란 노드에 글자를 입력한다. 기존 내용은 바뀐다.',
    params: { ref, text: { type: 'string', description: '입력할 글자' } },
    run: (engine, { ref: r, text }) => engine.perform(r!, 'type', text),
  },
  scroll: {
    description: '스크롤 가능한 노드를 위나 아래로 한 화면 스크롤한다(보이지 않는 항목을 찾을 때).',
    params: { ref, direction: { type: 'string', description: '스크롤 방향', enum: ['up', 'down'] } },
    run: (engine, { ref: r, direction }) => engine.perform(r!, 'scroll', direction),
  },
  back: {
    description: '이전 화면으로 돌아간다(시스템 뒤로).',
    params: {},
    run: async (engine) => {
      if (!engine.session) throw new EngineError('unsupported-action', `엔진 ${engine.name} 은 뒤로(session) 를 지원하지 않는다`);
      await engine.session.back();
    },
  },
  done: {
    description: '목표를 이루었을 때 부른다. 무엇을 확인했는지 summary 에 짧게 쓴다.',
    params: { summary: { type: 'string', description: '목표를 이룬 근거(화면에서 본 것)' } },
    run: async () => {},
    terminal: true,
  },
} satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;
export interface ToolCall { name: string; input: unknown }
export interface CheckedCall { name: ActionName; input: Record<string, string> }

/** 모델 API 의 tool 정의 모양(이름·설명·JSON 스키마). 추가 속성을 막아 닫힌 스키마로 준다 */
export interface ToolSchema {
  name: ActionName;
  description: string;
  input_schema: { type: 'object'; additionalProperties: false; required: string[]; properties: Record<string, ParamSpec> };
}

export function toolSchemas(): ToolSchema[] {
  return (Object.entries(ACTIONS) as Array<[ActionName, ActionSpec]>).map(([name, a]) => ({
    name, description: a.description,
    input_schema: { type: 'object', additionalProperties: false, required: Object.keys(a.params), properties: { ...a.params } },
  }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 실행 전 검사. 스키마와 같은 규칙(모든 인자 필수·문자열·enum·추가 인자 금지)을 같은 표에서 읽는다. 실패 사유는 모델에게 그대로 돌려준다 */
export function checkToolCall(call: ToolCall): { ok: true; call: CheckedCall } | { ok: false; error: string } {
  if (!Object.hasOwn(ACTIONS, call.name)) return { ok: false, error: `모르는 툴: ${call.name} (쓸 수 있는 툴: ${Object.keys(ACTIONS).join(', ')})` };
  const name = call.name as ActionName;
  const spec: ActionSpec = ACTIONS[name];
  if (!isRecord(call.input)) return { ok: false, error: `${name}: 인자는 객체여야 함` };
  const errors: string[] = [];
  for (const k of Object.keys(call.input)) if (!Object.hasOwn(spec.params, k)) errors.push(`${k}: ${name} 에 없는 인자`);
  for (const [k, p] of Object.entries(spec.params)) {
    const v = call.input[k];
    if (v === undefined) errors.push(`${k}: 필요한 인자`);
    else if (typeof v !== p.type) errors.push(`${k}: ${p.type} 이어야 함`);
    else if (p.enum && !p.enum.includes(v as string)) errors.push(`${k}: ${p.enum.join('|')} 중 하나여야 함`);
  }
  return errors.length ? { ok: false, error: `${name}: ${errors.join('; ')}` } : { ok: true, call: { name, input: call.input as Record<string, string> } };
}
