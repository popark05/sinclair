import type { ExtractType, ExtractValue } from '@sinclair/agent';
// `test()` API: 테스트 파일이 import 해서 등록하고, runTests 가 파일을 불러들여 모아 실행한다(e2e 방식, ADR 0001).
import type { Screen } from './screen.ts';
import type { LocatorAssertions, ExpectOptions } from './expect.ts';
import type { Locator } from './screen.ts';

/** 테스트 fn 이 받는 fixture. app 은 엔진의 session capability, expect 는 스텝이 기록되는 판정 */
export interface Fixtures {
  app: { open(target?: string): Promise<void>; back(): Promise<void>; restart(): Promise<void> };
  screen: Screen;
  expect: (locator: Locator, options?: ExpectOptions) => LocatorAssertions;
  /** 자연어 목표를 화면 조작으로(agent-layer). 실행기(모델)는 runTests 의 agent 옵션으로 준다 */
  agent: {
    act(goal: string): Promise<void>;
    /** 지금 화면에서 참이어야 한다(화면을 바꾸지 않는다). 거짓이면 판정 실패 */
    assert(statement: string): Promise<void>;
    /** 참이 될 때까지 다시 본다(기본 30초, 1초 간격. 화면이 그대로면 모델을 다시 부르지 않는다) */
    waitFor(condition: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
    /** 화면에서 값을 꺼낸다. type 은 'string'|'number'|'boolean' 또는 { 키: 그 셋 중 하나 }. secure 칸은 거부(secure-read) */
    extract<T extends ExtractType>(what: string, type: T): Promise<ExtractValue<T>>;
  };
  /** 이 테스트의 몇 번째 시도인지(1부터). 재시도 정책 검증용 샘플이 "첫 시도만 실패" 를 만들 때 쓴다; 제품 테스트가 분기하는 용도는 아니다 */
  attemptNo: number;
}

export type TestFn = (fixtures: Fixtures) => Promise<void> | void;

export interface TestCase {
  /** describe 경로를 " > " 로 이은 전체 이름 */
  name: string;
  fn: TestFn;
  skip: boolean;
}

/** 현재 로딩 중인 파일이 등록한 테스트. runTests 가 파일마다 비우고 모은다 */
const registry: TestCase[] = [];
const describePath: string[] = [];

function register(title: string, fn: TestFn, skip: boolean): void {
  registry.push({ name: [...describePath, title].join(' > '), fn, skip });
}

export interface TestApi {
  (title: string, fn: TestFn): void;
  describe(title: string, body: () => void): void;
  skip(title: string, fn: TestFn): void;
}

export const test: TestApi = Object.assign(
  (title: string, fn: TestFn) => register(title, fn, false),
  {
    describe(title: string, body: () => void) {
      describePath.push(title);
      try { body(); } finally { describePath.pop(); }
    },
    skip(title: string, fn: TestFn) { register(title, fn, true); },
  }
);

/** 지금까지 등록된 테스트를 꺼내고 비운다(runTests 전용) */
export function drainRegistry(): TestCase[] {
  return registry.splice(0);
}
