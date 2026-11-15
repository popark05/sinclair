// iOS 러너 빌드(.xctestrun) 찾기(ios-backend 05): SINCLAIR_IOS_XCTESTRUN, 없으면 리포 빌드 산출물(packages/device-layer/ios-runner/build.sh)의 가장 최근 실기기용.
import { execFileSync } from 'node:child_process';
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

export const REBUILD_HINT = 'packages/device-layer/ios-runner/build.sh --team <TEAM_ID> --device <UDID> 로 다시 빌드(무료 팀 서명은 7일)';

/** 프로비저닝 프로필(CMS 서명된 plist) → XML. macOS `security cms -D` */
const securityCmsDecode = (file: string): string => execFileSync('security', ['cms', '-D', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** 러너 빌드(.xctestrun 옆 Debug-iphoneos/*.app)의 프로비저닝 프로필 중 가장 이른 만료일. 프로필이 없거나 못 읽으면 undefined */
export function runnerProfileExpiry(xctestrun: string, decode: (file: string) => string = securityCmsDecode): Date | undefined {
  const dir = path.join(path.dirname(xctestrun), 'Debug-iphoneos');
  if (!existsSync(dir)) return undefined;
  let earliest: Date | undefined;
  for (const app of readdirSync(dir).filter((f) => f.endsWith('.app'))) {
    const file = path.join(dir, app, 'embedded.mobileprovision');
    if (!existsSync(file)) continue;
    let text: string;
    try { text = decode(file); } catch { continue; }
    const m = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(text);
    const d = m ? new Date(m[1]!) : undefined;
    if (d && !Number.isNaN(d.getTime()) && (!earliest || d < earliest)) earliest = d;
  }
  return earliest;
}

/** 찾은 빌드로 xcodebuild 실행기, 없으면 빌드 안내로 실패하는 실행기. 서명이 이미 만료됐으면 xcodebuild 를 띄우지 않고 다시 빌드 안내로 실패한다 */
export function iosLauncherFromEnv(env: NodeJS.ProcessEnv, opts: { productsDir?: string; log?: (line: string) => void; decodeProfile?: (file: string) => string; now?: Date } = {}): { launcher: IosRunnerLauncher; xctestrun?: string; expiresAt?: Date } {
  const xctestrun = resolveXctestrun(env, opts.productsDir);
  if (!xctestrun) return { launcher: noLauncher };
  const expiresAt = process.platform === 'darwin' || opts.decodeProfile ? runnerProfileExpiry(xctestrun, opts.decodeProfile) : undefined;
  if (expiresAt && expiresAt <= (opts.now ?? new Date())) {
    const msg = `iOS 러너 서명(프로비저닝 프로필)이 만료됨(${expiresAt.toISOString().slice(0, 16).replace('T', ' ')}Z) — ${REBUILD_HINT}`;
    return { launcher: { async start() { throw new Error(msg); } }, xctestrun, expiresAt };
  }
  return { launcher: xcodebuildLauncher({ xctestrun, ...(opts.log ? { log: opts.log } : {}) }), xctestrun, ...(expiresAt ? { expiresAt } : {}) };
}
