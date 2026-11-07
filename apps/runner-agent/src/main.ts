// CLI 엔트리: `sinclair-agent run [옵션]`. bin/sinclair-agent.mjs 가 부른다.
import { parseRunArgs, AgentConfigError, RUN_HELP } from './args.ts';
import { runOnce, EXIT } from './run-once.ts';

const HELP = `사용법: sinclair-agent <명령> [옵션]

  run     Cycle 의 Run 하나를 이 노드에서 실행하고 control-plane 에 보고한다

자세한 옵션: sinclair-agent run --help
`;

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') { process.stdout.write(HELP); return command ? EXIT.ok : EXIT.config; }
  if (command !== 'run') { console.error(`모르는 명령: ${command}\n\n${HELP}`); return EXIT.config; }
  try {
    const args = parseRunArgs(rest, env);
    if ('help' in args) { process.stdout.write(RUN_HELP); return EXIT.ok; }
    return await runOnce(args);
  } catch (err) {
    if (err instanceof AgentConfigError) { console.error(`설정 오류: ${err.message}\n\n${RUN_HELP}`); return EXIT.config; }
    throw err;
  }
}
