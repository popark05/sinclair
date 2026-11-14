#!/usr/bin/env node
// 얇은 셸: 소스가 .ts 라 --experimental-transform-types 가 필요하다. 플래그 없이 실행되면 같은 인자로 자신을 다시 띄운다.
// 리포 체크아웃 안에서만 동작한다(설치형 번들은 패키징 티켓). Windows 는 SIGTERM 전달이 없다.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

import { existsSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 설치 배치(소스 트리 없음)면 번들을 바로 실행한다. 리포 체크아웃에서는 항상 .ts 라 오래된 dist 가 개발 변경을 가리지 않는다
const bundle = path.join(here, '..', 'dist', 'runner-agent.mjs');
const hasSource = existsSync(path.join(here, '..', 'src', 'main.ts'));
const FLAG = '--experimental-transform-types';
if (!hasSource && existsSync(bundle)) {
  // 번들 모드는 자식 없이 같은 프로세스에서 돈다(변환 플래그 불필요). 신호는 main() 이 직접 받고 IPC 고아 방지는 해당 없음
  await import(bundle);
} else if (!process.execArgv.includes(FLAG)) {
  // IPC 채널을 하나 열어 둔다: 이 셸이 SIGKILL 등으로 죽으면 채널이 닫혀 자식이 'disconnect' 로 알고 종료한다(고아 서버 방지)
  const child = spawn(process.execPath, [FLAG, '--no-warnings=ExperimentalWarning', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  // 부모 셸이 사라짐(SIGTERM 과 같은 코드). run 워커(__worker)는 이 처리를 하지 않는다: 워커는 데몬의 IPC 가 끊기면 스스로 곧바로 끝난다(worker.ts, exit 143)
  if (!process.env.SINCLAIR_AGENT_WORKER) process.on('disconnect', () => process.exit(143));
  process.channel?.unref(); // 채널이 이벤트 루프를 붙잡아 main 이 끝난 뒤에도 프로세스가 남지 않도록
  // 테스트 파일의 '@sinclair/runner' 를 이 에이전트가 쓰는 runner 로(리포 밖 테스트 폴더 — Studio ~/Sinclair/tests — 에서도 풀리고 test() 레지스트리가 하나다). 번들은 cli.ts 가 같은 훅을 등록한다
  const { register } = await import('node:module');
  register(pathToFileURL(path.join(here, '..', 'src', 'hooks.mjs')).href, { data: { runner: import.meta.resolve('@sinclair/runner') } });
  const { main } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'));
  process.exitCode = await main();
}
