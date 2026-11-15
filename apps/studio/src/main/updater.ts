// Studio 자동 업데이트(studio-update 03). 서명하지 않은 사내 배포본이라 Squirrel.Mac(electron-updater 의 mac 경로, 코드 서명 필수)을 못 쓴다.
// 설정의 control-plane 이 내주는 배포(GET /studio/releases/latest?arch=)를 확인하고, 사람이 누르면 zip 을 받아 sha256·번들 id·버전을 맞춘 뒤
// 분리된 sh 가 Studio 가 끝나기를 기다렸다 .app 을 바꿔 끼우고 다시 띄운다(실패하면 옛 앱을 되돌린다). 같은 경로라 PATH 에 건 CLI 링크도 그대로다.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, constants, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { UpdateStatus } from '../shared/update.ts';

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000;
export const UPDATE_FIRST_CHECK_MS = 5_000;
export interface LatestRelease { version: string; name: string; sha256: string; size: number; url: string }

/** x.y.z[-pre] 비교. 같은 x.y.z 면 pre 가 없는 쪽이 새것. 형식이 아니면 NaN */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  const x = parse(a); const y = parse(b);
  if (!x || !y) return Number.NaN;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

/** 실행 파일(…/X.app/Contents/MacOS/X) → 번들 경로 */
export function appBundleOf(execPath: string): string | undefined {
  const app = path.resolve(execPath, '..', '..', '..');
  return app.endsWith('.app') && path.basename(path.dirname(execPath)) === 'MacOS' ? app : undefined;
}

/** 이 위치의 앱을 바꿔 끼울 수 없는 이유(없으면 undefined) */
export async function installBlocker(app: string): Promise<string | undefined> {
  if (app.includes('/AppTranslocation/')) return '격리된 위치에서 실행 중 — 응용 프로그램 폴더로 옮기고 xattr 로 격리 속성을 지운 뒤 다시 실행';
  if (app.startsWith('/Volumes/')) return '디스크 이미지에서 실행 중 — 응용 프로그램 폴더로 끌어 놓은 뒤 실행';
  try { await access(path.dirname(app), constants.W_OK); await access(app, constants.W_OK); } catch { return `${path.dirname(app)} 에 쓸 수 없음 — 관리자에게 새 버전 설치를 부탁하거나 쓸 수 있는 폴더로 옮긴다`; }
  return undefined;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** control-plane 의 최신 배포. 배포가 없으면(no-releases) undefined */
export async function fetchLatest(controlPlane: string, arch: string, doFetch: FetchLike): Promise<LatestRelease | undefined> {
  const res = await doFetch(`${controlPlane}/studio/releases/latest?arch=${encodeURIComponent(arch)}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`업데이트 확인 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const v = await res.json() as Partial<LatestRelease>;
  if (typeof v.version !== 'string' || typeof v.name !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256 ?? '') || !Number.isSafeInteger(v.size) || typeof v.url !== 'string' || !v.url.startsWith('/studio/releases/files/')) throw new Error('업데이트 정보가 올바르지 않음');
  return v as LatestRelease;
}

/** 받아서 크기·sha256 를 맞춘다. 맞지 않으면 지우고 실패 */
export async function downloadVerified(url: string, expect: { sha256: string; size: number }, dest: string, doFetch: FetchLike, onProgress?: (received: number) => void): Promise<void> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`내려받기 실패: HTTP ${res.status}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > expect.size) throw new Error(`받은 크기가 배포 목록(${expect.size} 바이트)보다 큼`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress?.(received);
    }
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
    if (received !== expect.size) throw new Error(`받은 크기 ${received} ≠ 배포 목록 ${expect.size}`);
    const got = hash.digest('hex');
    if (got !== expect.sha256) throw new Error(`sha256 불일치(받은 것 ${got.slice(0, 12)}…)`);
    await rename(part, dest);
  } catch (err) {
    // 열리는 중인 파일이 rm 뒤에 생기지 않게 닫힐 때까지 기다린다
    if (!out.closed) await new Promise<void>((r) => { out.once('close', () => r()); out.destroy(); });
    await rm(part, { force: true });
    throw err;
  }
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** 분리된 sh: Studio(pid)가 끝나기를 기다렸다(상한 60초) 앱을 바꾸고 다시 띄운다. 새 앱을 못 넣으면 옛 앱을 되돌린다 */
export function swapScript(i: { pid: number; app: string; staged: string; relaunchEnv?: Record<string, string> }): string {
  const env = Object.entries(i.relaunchEnv ?? {}).map(([k, v]) => ` --env ${q(`${k}=${v}`)}`).join('');
  return `#!/bin/sh
# Sinclair Studio 업데이트 교체(studio-update 03). 로그는 이 스크립트 옆 swap.log
APP=${q(i.app)}
NEW=${q(i.staged)}
OLD="$APP.updating-old"
n=0
while kill -0 ${i.pid} 2>/dev/null; do n=$((n+1)); if [ $n -gt 600 ]; then echo "Studio 가 60초 안에 끝나지 않아 업데이트를 그만둔다"; exit 1; fi; sleep 0.1; done
rm -rf "$OLD"
if ! mv "$APP" "$OLD"; then echo "옛 앱을 옮기지 못함"; open "$APP"; exit 1; fi
if mv "$NEW" "$APP"; then
  rm -rf "$OLD"
  echo "교체함: $APP"
else
  echo "새 앱을 넣지 못해 옛 앱을 되돌림"
  rm -rf "$APP"; mv "$OLD" "$APP"
fi
open "$APP"${env}
`;
}

export interface UpdaterDeps {
  current: string;
  arch: string;
  /** 바꿔 끼울 .app(설치본). 없으면 unsupported */
  app?: string;
  unsupportedReason?: string;
  bundleId: string;
  workDir: string;
  pid: number;
  controlPlane: () => Promise<string>;
  fetch: FetchLike;
  /** 명령 실행(ditto·plutil·xattr). 실패면 throw */
  run: (cmd: string, args: string[]) => Promise<string>;
  /** sh 를 분리해 띄운다(Studio 가 끝나도 산다) */
  spawnDetached: (script: string, log: string) => void;
  quit: () => void;
  relaunchEnv?: Record<string, string>;
  onChange: (s: UpdateStatus) => void;
  now?: () => number;
}

export function createUpdater(d: UpdaterDeps) {
  let status: UpdateStatus = d.app ? { state: 'idle', current: d.current } : { state: 'unsupported', current: d.current, reason: d.unsupportedReason ?? '설치본이 아님' };
  let latest: LatestRelease | undefined;
  const set = (s: UpdateStatus): void => { status = s; d.onChange(s); };
  const busy = (): boolean => status.state === 'checking' || status.state === 'downloading' || status.state === 'installing';

  /** manual: 사람이 누른 확인(실패를 error 로 보인다). 주기 확인은 조용히 idle 에 note */
  const check = async (manual = false): Promise<UpdateStatus> => {
    if (busy() || status.state === 'unsupported') return status;
    set({ state: 'checking', current: d.current });
    try {
      const r = await fetchLatest(await d.controlPlane(), d.arch, d.fetch);
      latest = r && compareVersions(r.version, d.current) > 0 ? r : undefined;
      set(latest ? { state: 'available', current: d.current, version: latest.version, size: latest.size } : { state: 'idle', current: d.current, checkedAt: new Date((d.now ?? Date.now)()).toISOString(), ...(r ? {} : { note: '이 control-plane 에 배포된 Studio 가 없음' }) });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      set(manual ? { state: 'error', current: d.current, error: m } : { state: 'idle', current: d.current, note: m });
    }
    return status;
  };

  const install = async (): Promise<UpdateStatus> => {
    if (busy() || !latest || !d.app) return status;
    const r = latest;
    const blocker = await installBlocker(d.app);
    if (blocker) { set({ state: 'error', current: d.current, version: r.version, error: blocker }); return status; }
    try {
      const cp = await d.controlPlane();
      const zip = path.join(d.workDir, r.name);
      set({ state: 'downloading', current: d.current, version: r.version, received: 0, size: r.size });
      let last = 0;
      await downloadVerified(`${cp}${r.url}`, r, zip, d.fetch, (received) => { if (received - last > r.size / 50 || received === r.size) { last = received; set({ state: 'downloading', current: d.current, version: r.version, received, size: r.size }); } });
      set({ state: 'installing', current: d.current, version: r.version });
      const stagedDir = path.join(d.workDir, 'staged');
      await rm(stagedDir, { recursive: true, force: true });
      await d.run('ditto', ['-x', '-k', zip, stagedDir]);
      const staged = path.join(stagedDir, path.basename(d.app));
      if (!(await stat(staged).catch(() => undefined))?.isDirectory()) throw new Error(`zip 안에 ${path.basename(d.app)} 이 없음`);
      const plist = path.join(staged, 'Contents', 'Info.plist');
      const id = (await d.run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).trim();
      const ver = (await d.run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).trim();
      if (id !== d.bundleId) throw new Error(`다른 앱의 배포본(${id})`);
      if (ver !== r.version) throw new Error(`배포본 버전 ${ver} 이 목록의 ${r.version} 과 다름`);
      await d.run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => '');
      await rm(zip, { force: true });
      const script = path.join(d.workDir, 'swap.sh');
      await writeFile(script, swapScript({ pid: d.pid, app: d.app, staged, ...(d.relaunchEnv ? { relaunchEnv: d.relaunchEnv } : {}) }), { mode: 0o700 });
      d.spawnDetached(script, path.join(d.workDir, 'swap.log'));
      d.quit();
    } catch (err) {
      set({ state: 'error', current: d.current, version: r.version, error: err instanceof Error ? err.message : String(err) });
    }
    return status;
  };

  return { status: () => status, check, install };
}
