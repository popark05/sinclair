// `test()` API: 테스트 파일이 import 해서 등록하고, runTests 가 파일을 불러들여 모아 실행한다(e2e 방식, ADR 0001).
import type { Screen } from './screen.ts';
import type { LocatorAssertions, ExpectOptions } from './expect.ts';
import type { Locator } from './screen.ts';

/** 테스트 fn 이 받는 fixture. app 은 엔진의 session capability, expect 는 스텝이 기록되는 판정 */
export interface Fixtures {
  app: { open(target?: string): Promise<void>; back(): Promise<void>; restart(): Promise<void> };
  screen: Screen;
  expect: (locator: Locator, options?: ExpectOptions) => LocatorAssertions;
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
