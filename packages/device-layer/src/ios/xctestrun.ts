// iOS 러너 빌드(.xctestrun) 찾기(ios-backend 05): SINCLAIR_IOS_XCTESTRUN, 없으면 리포 빌드 산출물(packages/device-layer/ios-runner/build.sh)의 가장 최근 실기기용.
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { noLauncher, type IosRunnerLauncher } from './ios-backend.ts';
import { xcodebuildLauncher } from './xcodebuild-launcher.ts';

/** 리포 체크아웃의 러너 빌드 산출물 폴더 */
export const REPO_IOS_RUNNER_PRODUCTS = path.resolve(import.meta.dirname, '../../ios-runner/build/Build/Products');

export function resolveXctestrun(env: NodeJS.ProcessEnv, productsDir: string = REPO_IOS_RUNNER_PRODUCTS): string | undefined {
  if (env.SINCLAIR_IOS_XCTESTRUN) return env.SINCLAIR_IOS_XCTESTRUN;
  if (!existsSync(productsDir)) return undefined;
  const found = readdirSync(productsDir).filter((f) => f.endsWith('.xctestrun') && f.includes('iphoneos')).map((f) => path.join(productsDir, f));
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** 찾은 빌드로 xcodebuild 실행기, 없으면 빌드 안내로 실패하는 실행기 */
export function iosLauncherFromEnv(env: NodeJS.ProcessEnv, opts: { productsDir?: string; log?: (line: string) => void } = {}): { launcher: IosRunnerLauncher; xctestrun?: string } {
  const xctestrun = resolveXctestrun(env, opts.productsDir);
  if (!xctestrun) return { launcher: noLauncher };
  return { launcher: xcodebuildLauncher({ xctestrun, ...(opts.log ? { log: opts.log } : {}) }), xctestrun };
}
