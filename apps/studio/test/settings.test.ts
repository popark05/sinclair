// @vitest-environment node
// Studio 설정(studio-console 03): control-plane 주소·테스트 폴더. 메인 프로세스가 userData/settings.json 에 저장한다.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseStudioSettings } from '../src/shared/settings.ts';
import { createSettingsStore } from '../src/main/settings-store.ts';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('parseStudioSettings', () => {
  it('http(s) 주소와 절대 경로(또는 ~/)만 받는다', () => {
    expect(parseStudioSettings({ controlPlane: 'http://127.0.0.1:4780', testsDir: '/tmp/x' })).toEqual({ ok: true, value: { controlPlane: 'http://127.0.0.1:4780', testsDir: '/tmp/x' } });
    expect(parseStudioSettings({ controlPlane: 'https://cp.example', testsDir: '~/Sinclair/tests' })).toMatchObject({ ok: true });
    expect(parseStudioSettings({ controlPlane: 'ftp://x', testsDir: '/tmp' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/controlPlane/)] });
    expect(parseStudioSettings({ controlPlane: 'http://x', testsDir: 'relative/dir' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/testsDir/)] });
    expect(parseStudioSettings({ controlPlane: 'http://x', testsDir: '/tmp', extra: 1 })).toMatchObject({ ok: false });
  });
});

describe('createSettingsStore', () => {
  it('파일이 없으면 기본값, 저장하면 다시 읽어도 같고, 잘못된 값은 거부하며 ~ 는 홈으로 편다', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-settings-'));
    const file = path.join(dir, 'settings.json');
    const store = createSettingsStore(file, os.homedir());
    expect(await store.get()).toEqual({ controlPlane: 'http://127.0.0.1:4780', testsDir: path.join(os.homedir(), 'Sinclair', 'tests') });
    await store.set({ controlPlane: 'http://10.0.0.5:4780', testsDir: '~/qa/tests' });
    expect(await createSettingsStore(file, os.homedir()).get()).toEqual({ controlPlane: 'http://10.0.0.5:4780', testsDir: path.join(os.homedir(), 'qa', 'tests') });
    await expect(store.set({ controlPlane: 'nope', testsDir: '/tmp' })).rejects.toThrow(/controlPlane/);
    fs.writeFileSync(file, '{ 깨진 json');
    expect(await createSettingsStore(file, os.homedir()).get()).toMatchObject({ controlPlane: 'http://127.0.0.1:4780' }); // 깨진 파일은 기본값
  });
});
