// 판정: `await expect(locator).toHaveText('…')`. 기한 안에 재관찰하며 통과하는 순간 끝난다. 화면을 바꾸지 않는다(locate 만).
import { EngineError, type SemanticNode } from '@sinclair/protocol';
import type { Locator } from './screen.ts';
import { summarize } from './summary.ts';

export interface ExpectOptions {
  /** 판정이 통과하기를 기다리는 상한(ms). 기본 5초: 액션(10초)보다 짧게 두어 "안 되는 판정" 이 빨리 드러나게 */
  timeoutMs?: number;
  /** 재관찰 간격(ms). locator 와 같은 이유로 100ms */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 100;

/** 판정 실패. 기대/실제와 마지막 관찰 요약을 담는다. 엔진 문제(ambiguous, secure-read 등)는 EngineError 그대로 */
export class AssertionError extends Error {
  constructor(readonly matcher: string, readonly expected: unknown, readonly actual: unknown, message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * 판정 규칙(specs/0002 러너 정책과 같다):
 * - 존재 판정(toBeVisible = 정확히 하나, toBeHidden = 하나도 없음)은 둘 이상 맞으면 .not 이어도 ambiguous 다(개수는 toHaveCount).
 * - 내용·상태 판정(toHaveText/…/toBeDisabled)은 노드가 정확히 하나일 때만 평가한다. 노드가 없으면 .not 이어도 "통과" 가
 *   아니라 기한까지 기다린다(없는 노드에 대한 공허한 참을 막는다).
 */
export interface LocatorAssertions {
  readonly not: LocatorAssertions;
  /** 정확히 하나 있다 */
  toBeVisible(): Promise<void>;
  /** 하나도 없다 */
  toBeHidden(): Promise<void>;
  toHaveText(text: string | RegExp): Promise<void>;
  toContainText(text: string): Promise<void>;
  toHaveValue(value: string | RegExp): Promise<void>;
  toBeChecked(): Promise<void>;
  toBeDisabled(): Promise<void>;
  toHaveCount(count: number): Promise<void>;
}

/** 한 번의 관찰에 대한 판정 결과. evaluable 이 false 면 판정할 대상이 없어(노드 없음) .not 이어도 통과가 아니다 */
interface Check { pass: boolean; actual: unknown; evaluable?: false }

type Matcher = (nodes: SemanticNode[]) => Check;

function single(nodes: SemanticNode[], locator: Locator): SemanticNode {
  if (nodes.length > 1) {
    throw new EngineError('ambiguous', `${locator.describe()} 에 맞는 노드가 ${nodes.length}개: ${summarize(nodes)}. 개수 판정은 toHaveCount 를 쓰세요`, { candidates: nodes.length });
  }
  return nodes[0]!;
}

function matchText(actual: string | undefined, expected: string | RegExp, contains: boolean): boolean {
  if (actual === undefined) return false;
  if (expected instanceof RegExp) return expected.test(actual);
  return contains ? actual.includes(expected) : actual === expected;
}

export function expect(locator: Locator, options: ExpectOptions = {}): LocatorAssertions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  function build(negated: boolean): LocatorAssertions {
    async function run(name: string, expected: unknown, matcher: Matcher): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      const started = Date.now();
      let nodes: SemanticNode[] = [];
      let check: Check = { pass: false, actual: undefined };
      for (;;) {
        nodes = await locator.probe(deadline);
        check = matcher(nodes);
        if (check.evaluable !== false && check.pass !== negated) return;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      const waited = Date.now() - started;
      const want = `${negated ? 'not.' : ''}${name}(${expected === undefined ? '' : expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
      throw new AssertionError(name, expected, check.actual,
        `${locator.describe()} 가 ${want} 를 ${waited}ms 안에 만족하지 않음. 실제: ${JSON.stringify(check.actual)}. 마지막 관찰: ${summarize(nodes)}`);
    }

    /** 노드가 정확히 하나일 때만 읽는 판정. secure 노드의 내용 읽기는 거부 */
    const reading = (name: string, expected: unknown, field: 'text' | 'value', contains: boolean) =>
      run(name, expected, (nodes) => {
        if (nodes.length === 0) return { pass: false, actual: '(노드 없음)', evaluable: false };
        const n = single(nodes, locator);
        if (n.states?.secure) throw new EngineError('secure-read', `${locator.describe()} 는 secure 노드라 ${field} 를 판정할 수 없음`, { ref: n.ref });
        return { pass: matchText(n[field], expected as string | RegExp, contains), actual: n[field] };
      });

    const state = (name: string, key: 'checked' | 'disabled') =>
      run(name, undefined, (nodes) => {
        if (nodes.length === 0) return { pass: false, actual: '(노드 없음)', evaluable: false };
        const n = single(nodes, locator);
        return { pass: n.states?.[key] === true, actual: n.states ?? {} };
      });

    return {
      get not() { return build(!negated); },
      toBeVisible: () => run('toBeVisible', undefined, (nodes) => { if (nodes.length > 1) single(nodes, locator); return { pass: nodes.length === 1, actual: `${nodes.length}개` }; }),
      toBeHidden: () => run('toBeHidden', undefined, (nodes) => { if (nodes.length > 1) single(nodes, locator); return { pass: nodes.length === 0, actual: `${nodes.length}개` }; }),
      toHaveText: (text) => reading('toHaveText', text, 'text', false),
      toContainText: (text) => reading('toContainText', text, 'text', true),
      toHaveValue: (value) => reading('toHaveValue', value, 'value', false),
      toBeChecked: () => state('toBeChecked', 'checked'),
      toBeDisabled: () => state('toBeDisabled', 'disabled'),
      toHaveCount: (count) => run('toHaveCount', count, (nodes) => ({ pass: nodes.length === count, actual: nodes.length })),
    };
  }
  return build(false);
}
