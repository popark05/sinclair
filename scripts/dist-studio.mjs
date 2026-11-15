/**
 * Sinclair Studio 설치본(studio-packaging 02): release/studio/Sinclair-Studio-<version>-mac-<arch>.{dmg,zip}
 *
 * 앱(asar): electron-vite 산출물 out/ + 의존성 없는 package.json — 메인은 워크스페이스를 런타임 import 하지 않고(main-imports 테스트), 렌더러는 vite 번들이라 node_modules 가 필요 없다.
 * Contents/Resources(asar 밖 — 작업 프로세스는 plain Node 라 asar 를 못 읽는다):
 *   node/node, node/LICENSE                          고정 버전 Node(scripts/dist.mjs 의 NODE_VERSION·fetchNode, SHASUMS256 검증)
 *   worker/worker.mjs                                작업 프로세스 단일 번들(scripts/build-studio-worker.mjs)
 *   worker/node_modules/usb, @node-usb/usb-<플랫폼>   네이티브 USB(번들에서 external)
 *   helper/sinclair-helper-<V>.apk(+.sha256)         Android 헬퍼 APK(리포 빌드) — 작업 프로세스와 CLI 가 함께 쓴다
 *   cli/bin/sinclair-agent, cli/bin/sinclair-control-plane   CLI 런처(studio-packaging 05): 위 node 로 cli/dist/*.mjs, SINCLAIR_RESOURCES_DIR=Resources
 *   cli/dist/*.mjs, cli/node_modules/usb…              CLI 번들(scripts/build-bundles.mjs — zip 설치본과 같은 번들)
 *   console/                                         Console 정적 빌드(CLI control-plane 이 /console 에서 서빙)
 * URL 스킴 sinclair:// 를 Info.plist 에 등록한다(studio-packaging 03). 아이콘 apps/studio/build/icon.icns. zip 과 함께 업데이트 배포 목록 latest-mac.json(studio-update). 서명·공증 없음(identity null).
 *
 * 사용: node scripts/dist-studio.mjs [--targets mac-arm64,mac-x64] [--out release/studio] [--dir]  (--dir: dmg·zip 대신 .app 폴더만, 빠른 확인용)
 * 사내망이면 NODE_EXTRA_CA_CERTS 로 Node·Electron 다운로드가 된다.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNode, NODE_VERSION, buildConsole } from './dist.mjs';
import { buildBundles } from './build-bundles.mjs';
import { ensureUsbPackage, USB_PACKAGE_DIR, USB_PLATFORM_PACKAGES } from './fetch-usb-binaries.mjs';
import { buildStudioWorker } from './build-studio-worker.mjs';
import { HELPER_APK_VERSION, helperApkFileName, DEFAULT_REPO_BUILD } from '../apps/runner-agent/src/helper-apk.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = path.join(root, 'apps', 'studio');
const requireStudio = createRequire(path.join(studio, 'package.json'));
export const STUDIO_TARGETS = { 'mac-arm64': 'arm64', 'mac-x64': 'x64' };
export const STUDIO_APP_ID = 'dev.sinclair.studio';
export const STUDIO_PRODUCT = 'Sinclair Studio';
export const URL_SCHEME = 'sinclair';
/** 앱 아이콘(scripts/build-studio-icon.mjs 가 icon.svg 에서 만들어 커밋해 둔 것) */
export const STUDIO_ICON = path.join(studio, 'build', 'icon.icns');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const RELEASE_MANIFEST = 'latest-mac.json';
/** control-plane studio-releases.ts 의 ReleaseManifest(같은 모양 — 그쪽 parseReleaseManifest 가 검사한다) */
export function releaseManifest({ version, zips, releasedAt = new Date().toISOString() }) {
  return { product: STUDIO_PRODUCT, version, releasedAt, files: zips.map(({ arch, path: p }) => { const buf = readFileSync(p); return { arch, name: path.basename(p), sha256: sha256(buf), size: buf.length }; }) };
}

/** electron-vite 빌드(out/) */
function buildStudioApp(log) {
  const r = spawnSync('pnpm', ['--filter', '@sinclair/studio', 'build'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Studio 빌드 실패(pnpm --filter @sinclair/studio build, 종료 ${r.status}):\n${r.stdout}\n${r.stderr}`);
  log('[studio] electron-vite build → apps/studio/out');
}

/** electron-builder 설정(타깃 하나). resDir 은 그 타깃의 Resources 원본 */
export function builderConfig({ version, appDir, outDir, resDir, electronVersion, arch }) {
  return {
    appId: STUDIO_APP_ID,
    productName: STUDIO_PRODUCT,
    copyright: 'Sinclair (사내 QA)',
    electronVersion,
    npmRebuild: false,
    asar: true,
    directories: { app: appDir, output: outDir },
    files: ['out/**/*', 'package.json'],
    extraResources: [{ from: resDir, to: '.', filter: ['**/*'] }],
    protocols: [{ name: 'Sinclair Studio', schemes: [URL_SCHEME] }],
    artifactName: `Sinclair-Studio-\${version}-mac-${arch}.\${ext}`,
    mac: { category: 'public.app-category.developer-tools', identity: null, target: ['dmg', 'zip'], icon: STUDIO_ICON },
    dmg: { title: `Sinclair Studio ${version}`, contents: [{ x: 130, y: 220, type: 'file' }, { x: 410, y: 220, type: 'link', path: '/Applications' }] },
  };
}

/**
 * Studio 안 CLI 런처(sh). 심링크(/usr/local/bin 등)로 불려도 진짜 위치를 따라가 Contents/Resources 를 찾는다.
 * 앱 이름에 공백이 있어 모든 경로를 따옴표로 감싼다. SINCLAIR_RESOURCES_DIR 를 사용자가 주면 그것이 이긴다.
 */
export function studioCliLauncher(app) {
  return `#!/bin/sh
# Sinclair ${app} 런처(Sinclair Studio.app 동봉). Contents/Resources/{node,cli,helper,console} 구조를 전제한다.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
RES=$(cd "$(dirname "$SELF")/../.." && pwd)
SINCLAIR_RESOURCES_DIR="\${SINCLAIR_RESOURCES_DIR:-$RES}" exec "$RES/node/node" --no-warnings=ExperimentalWarning "$RES/cli/dist/${app}.mjs" "$@"
`;
}
export const STUDIO_CLI_BINS = { 'sinclair-agent': 'runner-agent', 'sinclair-control-plane': 'control-plane' };

/** 스테이징: 앱 폴더(out + package.json)와 타깃별 Resources 원본 */
export async function stageStudio({ targets, stageDir, version, log = console.log, helperApk = DEFAULT_REPO_BUILD }) {
  if (!existsSync(helperApk)) throw new Error(`헬퍼 APK 가 없음: ${helperApk} — packages/device-layer/android-helper 에서 ./gradlew assembleDebug`);
  rmSync(stageDir, { recursive: true, force: true });
  const appDir = path.join(stageDir, 'app');
  mkdirSync(appDir, { recursive: true });
  cpSync(path.join(studio, 'out'), path.join(appDir, 'out'), { recursive: true });
  writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'sinclair-studio', productName: STUDIO_PRODUCT, version, description: 'Sinclair Studio — 테스트 작성·디버깅, 라이브 기기 뷰', author: 'Sinclair', main: 'out/main/index.js', type: 'module' }, null, 2));

  const workerDir = path.join(stageDir, 'worker-common');
  await buildStudioWorker(workerDir);
  log('[worker] esbuild 단일 번들');
  const cliDist = (await buildBundles(path.join(stageDir, 'cli-dist'))).outdir;
  log('[cli] control-plane·runner-agent 번들');
  const consoleDir = buildConsole(log);
  const apk = readFileSync(helperApk);
  const apkName = helperApkFileName();

  const res = {};
  for (const target of targets) {
    const dir = path.join(stageDir, 'res', target);
    mkdirSync(path.join(dir, 'node'), { recursive: true });
    const node = await fetchNode(target);
    copyFileSync(node.exe, path.join(dir, 'node', 'node'));
    chmodSync(path.join(dir, 'node', 'node'), 0o755);
    copyFileSync(node.license, path.join(dir, 'node', 'LICENSE'));
    log(`[node] v${NODE_VERSION} ${target} ${node.fromCache ? '(캐시)' : '(다운로드·검증)'}`);
    cpSync(workerDir, path.join(dir, 'worker'), { recursive: true });
    const platformDir = await ensureUsbPackage(target);
    cpSync(USB_PACKAGE_DIR, path.join(dir, 'worker', 'node_modules', 'usb'), { recursive: true, dereference: true });
    cpSync(platformDir, path.join(dir, 'worker', 'node_modules', '@node-usb', USB_PLATFORM_PACKAGES[target]), { recursive: true, dereference: true });
    cpSync(cliDist, path.join(dir, 'cli', 'dist'), { recursive: true });
    cpSync(USB_PACKAGE_DIR, path.join(dir, 'cli', 'node_modules', 'usb'), { recursive: true, dereference: true });
    cpSync(platformDir, path.join(dir, 'cli', 'node_modules', '@node-usb', USB_PLATFORM_PACKAGES[target]), { recursive: true, dereference: true });
    mkdirSync(path.join(dir, 'cli', 'bin'), { recursive: true });
    for (const [bin, app] of Object.entries(STUDIO_CLI_BINS)) { const p = path.join(dir, 'cli', 'bin', bin); writeFileSync(p, studioCliLauncher(app)); chmodSync(p, 0o755); }
    cpSync(consoleDir, path.join(dir, 'console'), { recursive: true });
    mkdirSync(path.join(dir, 'helper'), { recursive: true });
    writeFileSync(path.join(dir, 'helper', apkName), apk);
    writeFileSync(path.join(dir, 'helper', `${apkName}.sha256`), `${sha256(apk)}  ${apkName}\n`);
    writeFileSync(path.join(dir, 'VERSION'), `${version}\nnode ${NODE_VERSION}\nhelper ${HELPER_APK_VERSION}\ncli control-plane runner-agent\ntarget ${target}\n`);
    res[target] = dir;
  }
  return { appDir, res };
}

export async function distStudio({ targets = Object.keys(STUDIO_TARGETS), outDir = path.join(root, 'release', 'studio'), dirOnly = false, log = console.log } = {}) {
  for (const t of targets) if (!STUDIO_TARGETS[t]) throw new Error(`알 수 없는 대상: ${t} (${Object.keys(STUDIO_TARGETS).join(', ')})`);
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const electronVersion = JSON.parse(readFileSync(requireStudio.resolve('electron/package.json'), 'utf8')).version;
  buildStudioApp(log);
  const stageDir = path.join(outDir, 'stage');
  const { appDir, res } = await stageStudio({ targets, stageDir, version, log });
  const { build, Platform, Arch } = requireStudio('electron-builder');
  const outputs = [];
  for (const target of targets) {
    const arch = STUDIO_TARGETS[target];
    const config = builderConfig({ version, appDir, outDir, resDir: res[target], electronVersion, arch });
    if (dirOnly) config.mac.target = ['dir'];
    const files = await build({ targets: Platform.MAC.createTarget(dirOnly ? ['dir'] : ['dmg', 'zip'], Arch[arch]), config, publish: 'never' });
    for (const f of files.filter((x) => /\.(dmg|zip)$/.test(x))) log(`[${target}] ${path.relative(root, f)} (${(statSync(f).size / 1024 / 1024).toFixed(1)} MB)`);
    outputs.push(...files);
  }
  // 업데이트 배포 목록(studio-update 02): zip 과 함께 control-plane --studio-releases-dir 에 둔다
  if (!dirOnly) {
    const manifest = releaseManifest({ version, zips: outputs.filter((f) => f.endsWith('.zip')).map((f) => ({ arch: STUDIO_TARGETS[targets.find((t) => f.endsWith(`-mac-${STUDIO_TARGETS[t]}.zip`))], path: f })) });
    writeFileSync(path.join(outDir, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`[release] ${path.relative(root, path.join(outDir, RELEASE_MANIFEST))} — ${manifest.files.map((f) => f.arch).join(', ')}`);
  }
  return { outputs, appDirs: targets.map((t) => path.join(outDir, STUDIO_TARGETS[t] === 'x64' ? 'mac' : `mac-${STUDIO_TARGETS[t]}`, `${STUDIO_PRODUCT}.app`)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const t = arg('--targets');
  const r = await distStudio({ ...(t ? { targets: t === 'all' ? Object.keys(STUDIO_TARGETS) : t.split(',') } : {}), ...(arg('--out') ? { outDir: path.resolve(root, arg('--out')) } : {}), dirOnly: process.argv.includes('--dir') });
  for (const d of r.appDirs) if (existsSync(d)) console.log(`[app] ${path.relative(root, d)} — ${readdirSync(path.join(d, 'Contents', 'Resources')).filter((f) => !f.endsWith('.lproj')).join(', ')}`);
}
