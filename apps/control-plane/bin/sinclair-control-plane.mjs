#!/usr/bin/env node
// 얇은 셸: 소스가 .ts 라 --experimental-transform-types 가 필요하다. 플래그 없이 실행되면 같은 인자로 자신을 다시 띄운다.
// 지금은 리포 체크아웃 안에서만 동작한다(src/*.ts 와 워크스페이스 node_modules 전제). 설치형 배포는 esbuild 번들로 바꾼다(runner-agent 패키징 티켓).
// --no-warnings=ExperimentalWarning 은 node:sqlite 뿐 아니라 transform-types 경고도 끈다. Node 를 올릴 때 CHANGELOG 로 API 변경을 확인한다.
// Windows: SIGTERM 전달이 없고 child.kill 은 즉시 종료라 정상 close 를 보장하지 못한다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const FLAG = '--experimental-transform-types';
if (!process.execArgv.includes(FLAG)) {
  const child = spawn(process.execPath, [FLAG, '--no-warnings=ExperimentalWarning', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const { main } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'));
  process.exitCode = await main();
}
