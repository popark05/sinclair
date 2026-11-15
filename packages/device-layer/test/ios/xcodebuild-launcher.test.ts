// @vitest-environment node
// xcodebuild 실행기(ios-backend 05): 인자·TEST_RUNNER_ 환경변수, 끝나면 onExit 으로 사람이 읽을 사유(잠김·신뢰 안 됨·그 밖의 마지막 오류 줄).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { xcodebuildLauncher, xcodebuildArgs, exitReason } from '../../src/ios/xcodebuild-launcher.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fakeXcodebuild(body: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'fake-xcodebuild-'));
  dirs.push(d);
  const f = path.join(d, 'xcodebuild');
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

describe('xcodebuildLauncher', () => {
  it('인자와 토큰·포트 환경변수, 끝나면 onExit(종료 코드·사유)', async () => {
    expect(xcodebuildArgs('/x.xctestrun', 'U1')).toEqual(['test-without-building', '-xctestrun', '/x.xctestrun', '-destination', 'id=U1']);
    const bin = fakeXcodebuild('echo "args: $*"; echo "token=$TEST_RUNNER_SINCLAIR_TOKEN port=$TEST_RUNNER_SINCLAIR_PORT"; echo "Testing failed:"; echo "	The application could not be launched because the Developer App Certificate is not trusted."; exit 65');
    const lines: string[] = [];
    const exited = new Promise<string>((resolve) => {
      void xcodebuildLauncher({ xctestrun: '/x.xctestrun', xcodebuild: bin, log: (l) => lines.push(l) }).start('U1', 'tok', { onExit: resolve });
    });
    expect(await exited).toMatch(/코드 65.*개발자 앱 인증서를 신뢰/);
    expect(lines.join('\n')).not.toContain('tok'); // 토큰은 로그에 싣지 않는다
  });

  it('사유: 잠김·신뢰·기기 없음은 안내 문장, 그 밖에는 마지막 오류 줄', () => {
    expect(exitReason(['Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock 누군가의 iPhone to Continue"'])).toMatch(/잠금을 풀/);
    expect(exitReason(['Developer App Certificate is not trusted'])).toMatch(/VPN 및 기기 관리/);
    expect(exitReason(['xcodebuild: error: Unable to find a destination matching the provided destination specifier'])).toMatch(/기기를 찾지 못함/);
    expect(exitReason(['foo', 'error: something odd', 'bar'])).toBe('error: something odd');
    expect(exitReason([])).toBeUndefined();
  });
});

describe('resolveXctestrun', () => {
  it('환경변수가 먼저, 없으면 산출물 폴더의 가장 최근 실기기용(시뮬레이터용은 아님), 없으면 undefined', async () => {
    const { resolveXctestrun } = await import('../../src/ios/xctestrun.ts');
    const d = mkdtempSync(path.join(os.tmpdir(), 'xctestrun-'));
    dirs.push(d);
    expect(resolveXctestrun({}, d)).toBeUndefined();
    writeFileSync(path.join(d, 'SinclairRunner_iphonesimulator26.2-arm64.xctestrun'), '');
    writeFileSync(path.join(d, 'SinclairRunner_iphoneos26.2-arm64.xctestrun'), '');
    expect(resolveXctestrun({}, d)).toBe(path.join(d, 'SinclairRunner_iphoneos26.2-arm64.xctestrun'));
    expect(resolveXctestrun({ SINCLAIR_IOS_XCTESTRUN: '/a.xctestrun' }, d)).toBe('/a.xctestrun');
    expect(resolveXctestrun({}, path.join(d, 'none'))).toBeUndefined();
  });
});

describe('러너 서명 만료(무료 팀 7일)', () => {
  const profile = (exp: string) => `<?xml version="1.0"?><plist><dict><key>CreationDate</key><date>2026-11-15T00:47:24Z</date><key>ExpirationDate</key><date>${exp}</date></dict></plist>`;
  const layout = (exp: Record<string, string>) => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'xctestrun-exp-'));
    dirs.push(d);
    writeFileSync(path.join(d, 'SinclairRunner_iphoneos26.2-arm64.xctestrun'), '');
    for (const [app, e] of Object.entries(exp)) { mkdirSync(path.join(d, 'Debug-iphoneos', app), { recursive: true }); writeFileSync(path.join(d, 'Debug-iphoneos', app, 'embedded.mobileprovision'), e); }
    return path.join(d, 'SinclairRunner_iphoneos26.2-arm64.xctestrun');
  };

  it('빌드 산출물 앱들의 프로비저닝 프로필 중 가장 이른 만료일; 프로필이 없으면 undefined', async () => {
    const { runnerProfileExpiry } = await import('../../src/ios/xctestrun.ts');
    const x = layout({ 'SinclairRunner.app': '2026-11-23T00:00:00Z', 'SinclairRunnerUITests-Runner.app': '2026-11-22T00:47:24Z' });
    expect(runnerProfileExpiry(x, (f) => profile(readFileSync(f, 'utf8')))?.toISOString()).toBe('2026-11-22T00:47:24.000Z');
    expect(runnerProfileExpiry(layout({}), () => '')).toBeUndefined();
  });

  it('만료됐으면 실행기가 xcodebuild 를 띄우지 않고 다시 빌드 안내로 실패, 남았으면 만료일을 돌려준다', async () => {
    const { iosLauncherFromEnv } = await import('../../src/ios/xctestrun.ts');
    const x = layout({ 'SinclairRunnerUITests-Runner.app': '2026-11-22T00:47:24Z' });
    const decode = (f: string) => profile(readFileSync(f, 'utf8'));
    const expired = iosLauncherFromEnv({ SINCLAIR_IOS_XCTESTRUN: x }, { decodeProfile: decode, now: new Date('2026-11-23T00:00:00Z') });
    await expect(expired.launcher.start('U1', 't')).rejects.toThrow(/서명.*만료.*2026-11-22.*build\.sh/);
    const ok = iosLauncherFromEnv({ SINCLAIR_IOS_XCTESTRUN: x }, { decodeProfile: decode, now: new Date('2026-11-20T00:00:00Z') });
    expect(ok.expiresAt?.toISOString()).toBe('2026-11-22T00:47:24.000Z');
  });

  it('xcodebuild 출력의 만료·서명 오류도 다시 빌드 안내로', () => {
    expect(exitReason(['The provisioning profile has expired.'])).toMatch(/서명.*만료.*build\.sh/);
    expect(exitReason(["Unable to launch dev.sinclair.runner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user."])).toMatch(/서명.*build\.sh|신뢰/);
  });
});
