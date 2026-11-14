// 닫힌 툴 집합의 단일 원천: 툴마다 설명·인자·엔진 실행을 한 곳에 둔다. 모델에 주는 JSON 스키마(toolSchemas)와
// 실행 전 검사기(checkToolCall)와 실행(run)이 모두 이 표에서 나오므로 셋이 어긋날 수 없다(계약 테스트가 지킨다).
import { EngineError, type Engine } from '@sinclair/protocol';
import { enterSecret } from './secret-entry.ts';

/** 인자 하나의 모양. 지금은 문자열뿐(enum 으로 값 제한) — 툴이 늘면 여기에 타입을 더한다 */
export interface ParamSpec { type: 'string'; description: string; enum?: readonly string[] }

/** 실행에 필요한 것 중 모델이 주지 않는 것: 비밀값의 실제 값(루프·재생이 허용된 이름만 준다) */
export interface ActionContext { secret?(name: string): string | undefined }

export interface ActionSpec {
  description: string;
  params: Record<string, ParamSpec>;
  /** 엔진에 실행한다. done 처럼 화면을 건드리지 않는 툴은 아무것도 하지 않는다 */
  run(engine: Engine, input: Record<string, string>, ctx?: ActionContext): Promise<void>;
  /** 루프를 멈추는 툴(진행 불가 — 실패지만 사유가 분명하다) */
  blocks?: boolean;
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
    description: '입력란 노드에 글자를 입력한다. 기존 내용 뒤에 덧붙는다(비우지 않는다) — 새로 쓰려면 비어 있는 칸에 쓴다.',
    params: { ref, text: { type: 'string', description: '입력할 글자' } },
    run: (engine, { ref: r, text }) => engine.perform(r!, 'type', text),
  },
  submit: {
    // 검색·전송 버튼이 화면이 아니라 키보드에만 있는 앱(YouTube 검색 등)은 이것 없이는 입력을 확정할 수 없다 — 실기기에서 입력·지우기를 반복하다 턴 한도로 실패했다
    description: '입력란의 내용을 확정한다: 키보드의 실행 키(검색·이동·완료·Enter)를 누른다. 방금 입력한 칸의 ref 를 준다. 화면에 검색·전송 버튼이 없을 때 쓴다.',
    params: { ref },
    run: (engine, { ref: r }) => engine.perform(r!, 'press', 'Enter'),
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
  enter_secret: {
    description: '목표에 자리표시({{secret:이름}})로 주어진 비밀값(PIN·비밀번호·인증번호)을 넣는다. ref 가 입력칸이면 그 칸에 입력하고, 아니면 그 영역을 키패드로 보고 값의 글자마다 그 글자의 키를 누른다(누를 때마다 섞이는 보안 키패드도 된다). 값은 보이지 않는다 — 이름만 준다. 키패드의 숫자 키를 tap 으로 직접 누르지 않는다.',
    params: { ref, name: { type: 'string', description: '비밀값 이름 — 목표의 자리표시 {{secret:이름}} 의 이름(예: SIMPLE_PIN)' } },
    run: async (engine, { ref: r, name }, ctx) => {
      const value = ctx?.secret?.(name!);
      if (value === undefined) throw new EngineError('not-actionable', `쓸 수 없는 비밀값: ${name} — 목표에 주어진 자리표시만 쓸 수 있음`);
      await enterSecret(engine, r!, value);
    },
  },
  blocked: {
    description: '목표를 더 진행할 수 없을 때 멈춘다: 목표에 주어지지 않은 비밀값(PIN·비밀번호·인증번호)이 필요하거나, 사람만 할 수 있는 단계(본인인증·캡차·생체인증·실물 확인)를 만났을 때. 값을 지어내지 않는다 — 추측한 숫자를 누르지 말고 이것을 부른다.',
    params: {
      reason: { type: 'string', description: '무엇 때문에 막혔는지(지금 화면의 근거)' },
      secret: { type: 'string', description: '필요한 비밀값에 붙일 이름(대문자·숫자·_, 예: SIMPLE_PIN). 비밀값 때문이 아니면 빈 문자열' },
    },
    run: async () => {},
    blocks: true,
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

/** 모든 인자가 필수다: 스키마의 required 와 검사기가 이 한 함수로 같은 목록을 본다 */
const requiredOf = (spec: ActionSpec): string[] => Object.keys(spec.params);

/** ParamSpec → JSON 스키마 속성. 옮길 필드를 명시해 ParamSpec 에 새 필드가 생겨도 스키마 키워드로 새지 않게 한다 */
const toSchemaProperty = (p: ParamSpec): ParamSpec => ({ type: p.type, description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}) });

/** 매번 새 객체를 만든다: 실행기가 스키마를 고쳐도 ACTIONS 는 바뀌지 않는다 */
export function toolSchemas(): ToolSchema[] {
  return (Object.entries(ACTIONS) as Array<[ActionName, ActionSpec]>).map(([name, a]) => ({
    name, description: a.description,
    input_schema: { type: 'object', additionalProperties: false, required: requiredOf(a), properties: Object.fromEntries(Object.entries(a.params).map(([k, p]) => [k, toSchemaProperty(p)])) },
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
  for (const k of requiredOf(spec)) {
    const p = spec.params[k]!;
    const v = call.input[k];
    if (v === undefined) errors.push(`${k}: 필요한 인자`);
    else if (typeof v !== p.type) errors.push(`${k}: ${p.type} 이어야 함`);
    else if (p.enum && !p.enum.includes(v as string)) errors.push(`${k}: ${p.enum.join('|')} 중 하나여야 함`);
  }
  return errors.length ? { ok: false, error: `${name}: ${errors.join('; ')}` } : { ok: true, call: { name, input: call.input as Record<string, string> } };
}
