// CLI 엔트리: `sinclair-agent run [옵션]`. bin/sinclair-agent.mjs 가 부른다.
import { parseRunArgs, parseResumeArgs, AgentConfigError, RUN_HELP, RESUME_HELP } from './args.ts';
import { runOnce, EXIT } from './run-once.ts';
import { resumeSpool } from './spool.ts';

const HELP = `사용법: sinclair-agent <명령> [옵션]

  run      Cycle 의 Run 하나를 이 노드에서 실행하고 control-plane 에 보고한다
  resume   스풀에 남은(보내지 못한) 이벤트를 이어 보낸다

자세한 옵션: sinclair-agent run --help, sinclair-agent resume --help
`;

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') { process.stdout.write(HELP); return command ? EXIT.ok : EXIT.config; }
  if (command !== 'run' && command !== 'resume') { console.error(`모르는 명령: ${command}\n\n${HELP}`); return EXIT.config; }
  const help = command === 'run' ? RUN_HELP : RESUME_HELP;
  try {
    if (command === 'run') {
      const args = parseRunArgs(rest, env);
      if ('help' in args) { process.stdout.write(RUN_HELP); return EXIT.ok; }
      return await runOnce(args);
    }
    const args = parseResumeArgs(rest, env);
    if ('help' in args) { process.stdout.write(RESUME_HELP); return EXIT.ok; }
    const result = await resumeSpool({ dir: args.spool, ...(args.controlPlane ? { controlPlane: args.controlPlane } : {}), log: (l) => console.log(l) });
    for (const w of result.warnings) console.log(`  경고: ${w}`);
    console.log(`resume: 완료 ${result.resumed.length}, 미완 ${result.pending.length} (${args.spool})`);
    return result.pending.length ? EXIT.incomplete : EXIT.ok;
  } catch (err) {
    if (err instanceof AgentConfigError) { console.error(`설정 오류: ${err.message}\n\n${help}`); return EXIT.config; }
    throw err;
  }
}
