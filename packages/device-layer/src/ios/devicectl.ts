// iOS 설치 앱 확인(ios-backend 05): Xcode 의 `xcrun devicectl device info apps` 로. 기기 안 러너는 샌드박스라 설치 여부를 알 수 없고,
// 설치되지 않은 앱을 XCUITest 로 activate 하면 1분 넘게 붙잡혀 그동안 러너의 모든 요청이 밀린다(실기 iOS 17 확인). 그래서 호스트가 먼저 거른다.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DevicectlOptions {
  /** xcrun 인자로 실행(테스트가 바꿔 끼운다). 기본 execFile('xcrun') */
  run?: (args: string[]) => Promise<void>;
  /** 목록 캐시 수명(기본 30초) */
  ttlMs?: number;
}

const xcrun = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
  execFile('xcrun', args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
});

/** (udid, bundleId) → 설치됨 true · 없음 false · 모름 undefined(devicectl 실패) */
export function devicectlAppInstalled(opts: DevicectlOptions = {}): (udid: string, bundleId: string) => Promise<boolean | undefined> {
  const run = opts.run ?? xcrun;
  const ttl = opts.ttlMs ?? 30_000;
  const cache = new Map<string, { at: number; ids: Set<string> }>();
  const read = async (udid: string): Promise<Set<string> | undefined> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sinclair-devicectl-'));
    const out = path.join(dir, 'apps.json');
    try {
      await run(['devicectl', 'device', 'info', 'apps', '--device', udid, '--include-all-apps', '--json-output', out, '--quiet']);
      const j = JSON.parse(readFileSync(out, 'utf8')) as { result?: { apps?: Array<{ bundleIdentifier?: string }> } };
      const ids = new Set((j.result?.apps ?? []).map((a) => a.bundleIdentifier).filter((x): x is string => !!x));
      cache.set(udid, { at: Date.now(), ids });
      return ids;
    } catch { return undefined; } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  return async (udid, bundleId) => {
    const c = cache.get(udid);
    if (c && Date.now() - c.at < ttl && c.ids.has(bundleId)) return true;
    // 캐시에 없으면(막 깐 앱일 수 있다) 새로 읽는다
    const ids = await read(udid);
    return ids ? ids.has(bundleId) : undefined;
  };
}
