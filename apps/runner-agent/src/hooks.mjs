// node:module resolve 훅(번들 전용): 사용자 테스트 파일의 '@sinclair/runner' 를 번들의 runner.mjs 로 넘긴다.
// 에이전트와 같은 모듈 인스턴스를 쓰게 되어 test() 레지스트리가 하나다. build-bundles.mjs 가 dist/ 로 복사한다.
const RUNNER = new URL('./runner.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@sinclair/runner') return { url: RUNNER, shortCircuit: true };
  return next(specifier, context);
}
