// @vitest-environment node
// devicectl 설치 앱 목록(ios-backend 05): JSON 결과를 읽고, 기기마다 잠깐 캐시하며, 목록에 없으면 한 번 새로 읽는다. 실패하면 모름(undefined).
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { devicectlAppInstalled } from '../../src/ios/devicectl.ts';

const okRunner = (ids: string[], calls: string[][]) => async (args: string[]) => {
  calls.push(args);
  const out = args[args.indexOf('--json-output') + 1]!;
  writeFileSync(out, JSON.stringify({ result: { apps: ids.map((bundleIdentifier) => ({ bundleIdentifier })) } }));
};

describe('devicectlAppInstalled', () => {
  it('목록에 있으면 true, 없으면 새로 한 번 더 읽고 false; 캐시 안의 있는 앱은 다시 읽지 않는다', async () => {
    const calls: string[][] = [];
    const installed = devicectlAppInstalled({ run: okRunner(['com.apple.Preferences'], calls), ttlMs: 60_000 });
    expect(await installed('U1', 'com.apple.Preferences')).toBe(true);
    expect(await installed('U1', 'com.apple.Preferences')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 6)).toEqual(['devicectl', 'device', 'info', 'apps', '--device', 'U1']);
    expect(await installed('U1', 'com.google.android.youtube')).toBe(false);
    expect(calls).toHaveLength(2); // 막 깐 앱일 수 있어 한 번 새로 읽는다
  });

  it('devicectl 이 실패하면 모름(undefined) — 막지 않는다', async () => {
    const installed = devicectlAppInstalled({ run: async () => { throw new Error('xcrun 없음'); } });
    expect(await installed('U1', 'com.x')).toBeUndefined();
  });

  it('목록(devicectlApps.list)과 설치 확인이 같은 캐시를 쓴다', async () => {
    const { devicectlApps } = await import('../../src/ios/devicectl.ts');
    const calls: string[][] = [];
    const apps = devicectlApps({ run: okRunner(['com.apple.Preferences', 'com.apple.calculator'], calls), ttlMs: 60_000 });
    expect(await apps.list('U1')).toEqual(['com.apple.Preferences', 'com.apple.calculator']);
    expect(await apps.installed('U1', 'com.apple.calculator')).toBe(true);
    expect(await apps.list('U1')).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});

