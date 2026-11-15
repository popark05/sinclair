// @vitest-environment node
// xcodebuild 실행기(ios-backend 05): 인자·TEST_RUNNER_ 환경변수, 끝나면 onExit 으로 사람이 읽을 사유(잠김·신뢰 안 됨·그 밖의 마지막 오류 줄).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
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
