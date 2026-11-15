// iOS 러너 실행기(ios-backend 03·05): build-for-testing 으로 만든 .xctestrun 을 `xcodebuild test-without-building` 으로 그 기기에서 돌린다(Xcode 필요).
// 토큰·포트는 TEST_RUNNER_ 접두 환경변수로 테스트 러너 프로세스에 전해진다(xcodebuild 가 접두를 떼고 넘긴다).
// xcodebuild 가 끝나면(러너가 죽었거나 설치·실행 실패) onExit 으로 사람이 읽을 사유를 알린다 — 백엔드는 그 기기를 unreachable 로 두고 다음 호출에서 다시 띄운다.
import { spawn } from 'node:child_process';
import type { IosRunnerLauncher } from './ios-backend.ts';
import { IOS_RUNNER_PORT } from './runner-client.ts';

export interface XcodebuildLauncherOptions { xctestrun: string; xcodebuild?: string; log?: (line: string) => void }

export function xcodebuildArgs(xctestrun: string, udid: string): string[] {
  return ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${udid}`];
}

/** xcodebuild 출력의 마지막 줄들에서 종료 사유. 흔한 경우는 해야 할 일로 바꿔 말한다 */
export function exitReason(lines: readonly string[]): string | undefined {
  const all = lines.join('\n');
  if (/Unlock .* to Continue|device is locked/i.test(all)) return '기기 잠금을 풀어야 함(러너 설치·실행은 잠금 해제 상태에서만)';
  if (/Developer App Certificate is not trusted|not trusted/i.test(all)) return 'iPhone 이 개발자 앱 인증서를 신뢰하지 않음 — 설정 → 일반 → VPN 및 기기 관리에서 신뢰';
  if (/Unable to find a destination/i.test(all)) return 'xcodebuild 가 기기를 찾지 못함(개발자 모드·이 Mac 신뢰·케이블 확인)';
  if (/Developer Mode/i.test(all) && /disabled|not enabled|off/i.test(all)) return 'iPhone 의 개발자 모드가 꺼져 있음';
  return [...lines].reverse().find((l) => /error|failed/i.test(l))?.trim();
}

/** 노이즈가 많은 xcodebuild 출력 중 진행·오류 줄만(사유 판정용으로 최근 40줄을 보관) */
const INTERESTING = /error|failed|Testing|Test Suite|started|Unlock|trusted|listening|destination/i;

export function xcodebuildLauncher(opts: XcodebuildLauncherOptions): IosRunnerLauncher {
  return {
    async start(udid, token, hooks) {
      const child = spawn(opts.xcodebuild ?? 'xcodebuild', xcodebuildArgs(opts.xctestrun, udid), {
        env: { ...process.env, TEST_RUNNER_SINCLAIR_TOKEN: token, TEST_RUNNER_SINCLAIR_PORT: String(IOS_RUNNER_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const recent: string[] = [];
      let partial = '';
      const onData = (d: Buffer): void => {
        const parts = (partial + d.toString()).split('\n');
        partial = parts.pop() ?? '';
        for (const raw of parts) {
          const l = raw.split(token).join('<token>').trim();
          if (!l || !INTERESTING.test(l) || /IDERunDestination/.test(l)) continue;
          recent.push(l);
          if (recent.length > 40) recent.shift();
          opts.log?.(`xcodebuild: ${l.slice(0, 200)}`);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      let stopping = false;
      child.once('exit', (code, signal) => {
        if (stopping) return;
        const why = exitReason(recent);
        hooks?.onExit(`xcodebuild 종료(${code !== null ? `코드 ${code}` : `신호 ${signal}`})${why ? `: ${why}` : ''}`);
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', (e) => reject(new Error(`xcodebuild 를 실행하지 못함(Xcode 가 설치돼 있나?): ${e.message}`)));
      });
      return { stop: async () => { stopping = true; if (child.exitCode === null) child.kill('SIGTERM'); } };
    },
  };
}
