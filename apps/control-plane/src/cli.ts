// 번들 엔트리: main() 을 실행하고 종료 코드를 남긴다. bin 셸(개발)과 dist/control-plane.mjs(설치본)가 같이 쓴다.
import { main } from './main.ts';

process.exitCode = await main();
