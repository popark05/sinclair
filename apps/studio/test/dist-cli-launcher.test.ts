// Studio 설치본 안 CLI 런처(studio-packaging 05): 앱 이름의 공백·심링크(PATH 에 건 링크)로 불려도 동봉 Node 로 cli/dist 번들을 돌리고 자산 위치를 Resources 로 준다.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { studioCliLauncher, STUDIO_CLI_BINS } from '../../../scripts/dist-studio.mjs';

describe.skipIf(process.platform === 'win32')('studioCliLauncher', () => {
  it('심링크로 불려도 Resources 를 찾아 node 로 번들을 실행, 인자·종료 코드·SINCLAIR_RESOURCES_DIR', () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'studio-cli-')));
    const res = path.join(tmp, 'Sinclair Studio.app', 'Contents', 'Resources');
    mkdirSync(path.join(res, 'node'), { recursive: true });
    symlinkSync(process.execPath, path.join(res, 'node', 'node'));
    mkdirSync(path.join(res, 'cli', 'dist'), { recursive: true });
    mkdirSync(path.join(res, 'cli', 'bin'));
    writeFileSync(path.join(res, 'cli', 'dist', 'runner-agent.mjs'), "console.log(JSON.stringify({ argv: process.argv.slice(2), res: process.env.SINCLAIR_RESOURCES_DIR })); process.exit(3);\n");
    const bin = path.join(res, 'cli', 'bin', 'sinclair-agent');
    writeFileSync(bin, studioCliLauncher(STUDIO_CLI_BINS['sinclair-agent']!));
    chmodSync(bin, 0o755);
    // PATH 디렉터리에 건 링크, 그 링크를 다시 가리키는 상대 링크
    mkdirSync(path.join(tmp, 'bin'));
    symlinkSync(bin, path.join(tmp, 'bin', 'sinclair-agent'));
    symlinkSync('sinclair-agent', path.join(tmp, 'bin', 'sa'));
    for (const via of [bin, path.join(tmp, 'bin', 'sinclair-agent'), path.join(tmp, 'bin', 'sa')]) {
      let out = ''; let code = 0;
      try { execFileSync(via, ['daemon', 'a b'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }); } catch (e) { const err = e as { status: number; stdout: string }; code = err.status; out = err.stdout; }
      expect(code).toBe(3);
      expect(JSON.parse(out)).toEqual({ argv: ['daemon', 'a b'], res });
    }
    // 사용자가 준 자산 위치가 이긴다
    let out = '';
    try { execFileSync(bin, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SINCLAIR_RESOURCES_DIR: '/x' } }); } catch (e) { out = (e as { stdout: string }).stdout; }
    expect(JSON.parse(out).res).toBe('/x');
    expect(STUDIO_CLI_BINS).toEqual({ 'sinclair-agent': 'runner-agent', 'sinclair-control-plane': 'control-plane' });
  });
});
