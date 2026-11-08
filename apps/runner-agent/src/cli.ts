// 번들 엔트리: 번들로 실행 중이면 테스트 파일의 '@sinclair/runner' 를 번들 runner 로 넘기는 resolve 훅을 먼저 등록한다.
import { register } from 'node:module';
import { main } from './main.ts';
import { isBundled } from './resources.ts';

if (isBundled()) register('./hooks.mjs', import.meta.url);
process.exitCode = await main();
