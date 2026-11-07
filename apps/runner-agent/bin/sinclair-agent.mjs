#!/usr/bin/env node
// 얇은 셸: 소스가 .ts 라 --experimental-transform-types 가 필요하다. 플래그 없이 실행되면 같은 인자로 자신을 다시 띄운다.
// 리포 체크아웃 안에서만 동작한다(설치형 번들은 패키징 티켓). Windows 는 SIGTERM 전달이 없다.
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
