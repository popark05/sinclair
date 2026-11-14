// node:module resolve 훅: 사용자 테스트 파일의 '@sinclair/runner' 를 에이전트가 쓰는 runner 로 넘긴다.
// 에이전트와 같은 모듈 인스턴스를 쓰게 되어 test() 레지스트리가 하나다. 테스트 폴더가 어디에 있든(리포 밖 Studio 테스트 폴더 포함) 풀린다.
// 번들: 옆의 runner.mjs(build-bundles.mjs 가 dist/ 로 복사). 리포 체크아웃: register 의 data.runner(에이전트가 import.meta.resolve 한 runner).
let RUNNER = new URL('./runner.mjs', import.meta.url).href;

export function initialize(data) {
  if (data && typeof data.runner === 'string') RUNNER = data.runner;
}

export async function resolve(specifier, context, next) {
  if (specifier === '@sinclair/runner') return { url: RUNNER, shortCircuit: true };
  return next(specifier, context);
}
