// CLI 엔트리: `sinclair-agent run [옵션]`. bin/sinclair-agent.mjs 가 부른다.
import { parseRunArgs, parseResumeArgs, parseDaemonArgs, AgentConfigError, RUN_HELP, RESUME_HELP, DAEMON_HELP } from './args.ts';
import { runOnce, EXIT } from './run-once.ts';
import { resumeSpool } from './spool.ts';
import { runDaemon } from './daemon.ts';

const HELP = `사용법: sinclair-agent <명령> [옵션]

  run      Cycle 의 Run 하나를 이 노드에서 실행하고 control-plane 에 보고한다
  daemon   타깃별로 대기 중인 Run 을 클레임해 실행·보고를 반복한다
  resume   스풀에 남은(보내지 못한) 이벤트를 이어 보낸다

자세한 옵션: sinclair-agent <명령> --help
`;

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') { process.stdout.write(HELP); return command ? EXIT.ok : EXIT.config; }
  if (command !== 'run' && command !== 'resume' && command !== 'daemon') { console.error(`모르는 명령: ${command}\n\n${HELP}`); return EXIT.config; }
  const help = command === 'run' ? RUN_HELP : command === 'daemon' ? DAEMON_HELP : RESUME_HELP;
  try {
    if (command === 'run') {
      const args = parseRunArgs(rest, env);
      if ('help' in args) { process.stdout.write(RUN_HELP); return EXIT.ok; }
      return await runOnce(args);
    }
    if (command === 'daemon') {
      const args = parseDaemonArgs(rest, env);
      if ('help' in args) { process.stdout.write(DAEMON_HELP); return EXIT.ok; }
      const aborter = new AbortController();
      const stop = (sig: string) => { console.log(`${sig} 수신, 진행 중 테스트를 마치고 멈춤(남은 테스트는 skipped, run 은 cancelled)`); aborter.abort(); };
      process.once('SIGTERM', () => stop('SIGTERM'));
      process.once('SIGINT', () => stop('SIGINT'));
      const summary = await runDaemon(args, { signal: aborter.signal });
      console.log(`데몬 요약: run ${summary.runs.length}개 (${summary.runs.map((r) => `${r.targetId}:${r.exitCode}`).join(', ')}), resume ${summary.resumed}`);
      // 중단(cancelled)된 run 은 이 노드의 실패가 아니다: 계획된 종료·lease 상실이고, 케이스 결과는 Cycle 뷰가 blocked·대체로 드러낸다
      return summary.runs.every((r) => r.exitCode === EXIT.ok || r.exitCode === EXIT.cancelled) ? EXIT.ok : EXIT.testsFailed;
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
