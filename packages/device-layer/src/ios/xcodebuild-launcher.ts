// iOS 러너 실행기(ios-backend 03): build-for-testing 으로 만든 .xctestrun 을 `xcodebuild test-without-building` 으로 그 기기에서 돌린다(Xcode 필요).
// 토큰·포트는 TEST_RUNNER_ 접두 환경변수로 테스트 러너 프로세스에 전해진다(xcodebuild 가 접두를 떼고 넘긴다).
import { spawn } from 'node:child_process';
import type { IosRunnerLauncher } from './ios-backend.ts';
import { IOS_RUNNER_PORT } from './runner-client.ts';

export interface XcodebuildLauncherOptions { xctestrun: string; xcodebuild?: string; log?: (line: string) => void }

export function xcodebuildArgs(xctestrun: string, udid: string): string[] {
  return ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${udid}`];
}

export function xcodebuildLauncher(opts: XcodebuildLauncherOptions): IosRunnerLauncher {
  return {
    async start(udid, token) {
      const child = spawn(opts.xcodebuild ?? 'xcodebuild', xcodebuildArgs(opts.xctestrun, udid), {
        env: { ...process.env, TEST_RUNNER_SINCLAIR_TOKEN: token, TEST_RUNNER_SINCLAIR_PORT: String(IOS_RUNNER_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onLine = (d: Buffer): void => { for (const l of d.toString().split('\n')) if (/error|Testing|Test Suite|started/i.test(l)) opts.log?.(`xcodebuild: ${l.trim().slice(0, 200)}`); };
      child.stdout.on('data', onLine);
      child.stderr.on('data', onLine);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', (e) => reject(new Error(`xcodebuild 를 실행하지 못함(Xcode 가 설치돼 있나?): ${e.message}`)));
      });
      return { stop: async () => { if (child.exitCode === null) child.kill('SIGTERM'); } };
    },
  };
}
